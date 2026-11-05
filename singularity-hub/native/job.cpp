#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <cstdio>
#include <sddl.h>
#include <wincrypt.h>
#include <fcntl.h>
#include <io.h>
#include <array>
#include <vector>
#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "crypt32.lib")
#include <string>

// Quotes one argument for CreateProcess so that the child's CommandLineToArgvW reads it back unchanged.
static std::wstring quoteArgument(const std::wstring& value) {
    if (!value.empty() && value.find_first_of(L" \t\n\v\"") == std::wstring::npos) {
        return value;
    }
    std::wstring quoted = L"\"";
    for (size_t i = 0;; ++i) {
        size_t slashes = 0;
        while (i < value.size() && value[i] == L'\\') { ++i; ++slashes; }
        if (i == value.size()) {
            quoted.append(slashes * 2, L'\\');
            break;
        }
        if (value[i] == L'"') {
            quoted.append(slashes * 2 + 1, L'\\');
            quoted.push_back(L'"');
        } else {
            quoted.append(slashes, L'\\');
            quoted.push_back(value[i]);
        }
    }
    quoted.push_back(L'"');
    return quoted;
}

// A bounded binary protocol on anonymous pipes keeps plaintext out of arguments and disk.
static int protectRecord(bool decrypt) {
    if (_setmode(_fileno(stdin), _O_BINARY) == -1 || _setmode(_fileno(stdout), _O_BINARY) == -1) {
        return 9;
    }
    std::vector<BYTE> buffer(1024 * 1024);
    const size_t size = std::fread(buffer.data(), 1, buffer.size(), stdin);
    if (!size || size == buffer.size() || std::ferror(stdin)) {
        SecureZeroMemory(buffer.data(), buffer.size());
        return 9;
    }
    DATA_BLOB input{static_cast<DWORD>(size), buffer.data()};
    DATA_BLOB output{};
    const BOOL ok = decrypt
        ? CryptUnprotectData(&input, nullptr, nullptr, nullptr, nullptr, CRYPTPROTECT_UI_FORBIDDEN, &output)
        : CryptProtectData(&input, L"Singularity OpenCode recovery", nullptr, nullptr, nullptr, CRYPTPROTECT_UI_FORBIDDEN, &output);
    SecureZeroMemory(buffer.data(), buffer.size());
    if (!ok) {
        return 9;
    }
    const bool written = std::fwrite(output.pbData, 1, output.cbData, stdout) == output.cbData && std::fflush(stdout) == 0;
    SecureZeroMemory(output.pbData, output.cbData);
    LocalFree(output.pbData);
    return written ? 0 : 9;
}

static int inspectHelper(const wchar_t* id, const wchar_t* expectedPid, bool stop) {
    const std::wstring name = L"\\\\.\\pipe\\singularity-job-" + std::wstring(id);
    const HANDLE pipe = CreateFileW(name.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, 0, nullptr);
    if (pipe == INVALID_HANDLE_VALUE) { return 10; }
    ULONG pid = 0;
    wchar_t actual[32768]{}, expected[32768]{};
    DWORD length = ARRAYSIZE(actual);
    const HANDLE process = GetNamedPipeServerProcessId(pipe, &pid) && std::to_wstring(pid) == expectedPid
        ? OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid) : nullptr;
    const bool trusted = process && QueryFullProcessImageNameW(process, 0, actual, &length) &&
        GetModuleFileNameW(nullptr, expected, ARRAYSIZE(expected)) && _wcsicmp(actual, expected) == 0;
    if (process) { CloseHandle(process); }
    std::array<char, 65> command{};
    DWORD count = 0;
    bool ok = false;
    if (trusted && std::fread(command.data(), 1, 64, stdin) == 64) {
        command[64] = stop ? 'x' : 'i';
        ok = WriteFile(pipe, command.data(), static_cast<DWORD>(command.size()), &count, nullptr) && count == command.size();
    }
    SecureZeroMemory(command.data(), command.size());
    char reply[256]{};
    if (ok) {
        ok = ReadFile(pipe, reply, sizeof(reply), &count, nullptr) && count > 0;
    }
    CloseHandle(pipe);
    if (!ok) { return 10; }
    return std::fwrite(reply, 1, count, stdout) == count ? 0 : 10;
}

int wmain(int argc, wchar_t** argv) {
    if (argc == 2 && std::wstring(argv[1]) == L"protect-recovery") {
        return protectRecord(false);
    }
    if (argc == 2 && std::wstring(argv[1]) == L"unprotect-recovery") {
        return protectRecord(true);
    }
    if (argc == 4 && (std::wstring(argv[1]) == L"inspect-job" || std::wstring(argv[1]) == L"stop-job")) {
        return inspectHelper(argv[2], argv[3], std::wstring(argv[1]) == L"stop-job");
    }
    // `run-cli <hub pid> <pipe id> <sid> <workspace> <executable> [arguments...]` runs a one-shot command line tool (Claude Code)
    // in a Job Object and gives it this process's stdin, stdout and stderr, so the Hub can read its structured output. When
    // the Hub process ends, the job is terminated: a crashed Hub never leaves a running agent behind.
    const bool runTest = argc >= 7 && std::wstring(argv[1]) == L"run-test";
    const bool runCli = runTest || (argc >= 7 && std::wstring(argv[1]) == L"run-cli");
    if (runCli ? std::wstring(argv[2]).find_first_not_of(L"0123456789") != std::wstring::npos
               : (argc != 6 || std::wstring(argv[3]).find_first_not_of(L"0123456789") != std::wstring::npos)) {
        return 2;
    }
    const std::wstring pipeId = runCli ? argv[3] : argv[4];
    const std::wstring pipeName = L"\\\\.\\pipe\\singularity-job-" + pipeId;
    const std::wstring sid = runCli ? argv[4] : argv[5];
    if (pipeId.find_first_not_of(L"0123456789abcdef-") != std::wstring::npos ||
        sid.find_first_not_of(L"S0123456789-") != std::wstring::npos) {
        return 2;
    }
    HANDLE parent = nullptr;
    if (runCli) {
        parent = OpenProcess(SYNCHRONIZE, FALSE, static_cast<DWORD>(std::wcstoul(argv[2], nullptr, 10)));
        if (!parent) {
            return 2;
        }
    }
    char control[65]{};
    if (GetEnvironmentVariableA("SINGULARITY_JOB_CONTROL", control, sizeof(control)) != 64) {
        return 2;
    }
    // The server process needs its HTTP credential, but does not inherit the job control capability.
    SetEnvironmentVariableA("SINGULARITY_JOB_CONTROL", nullptr);
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    const std::wstring acl = L"D:P(A;;GA;;;" + sid + L")";
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(acl.c_str(), SDDL_REVISION_1, &descriptor, nullptr)) {
        return 3;
    }
    SECURITY_ATTRIBUTES pipeAttributes{sizeof(pipeAttributes), descriptor, FALSE};
    const HANDLE pipe = CreateNamedPipeW(pipeName.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_NOWAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 0, 256, 0, &pipeAttributes);
    LocalFree(descriptor);
    if (pipe == INVALID_HANDLE_VALUE) {
        return 3;
    }
    HANDLE job = CreateJobObjectW(nullptr, nullptr);
    if (!job) {
        return 3;
    }

    // OpenCode inherits only the NUL handle: its unstructured output can contain credentials. A `run-cli` tool instead gets this
    // process's three standard handles, because its structured events are what the Hub reads.
    const HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
    const HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
    const HANDLE errors = GetStdHandle(STD_ERROR_HANDLE);
    const DWORD inherit = runCli ? HANDLE_FLAG_INHERIT : 0;
    SetHandleInformation(input, HANDLE_FLAG_INHERIT, inherit);
    SetHandleInformation(output, HANDLE_FLAG_INHERIT, inherit);
    SetHandleInformation(errors, HANDLE_FLAG_INHERIT, inherit);
    SECURITY_ATTRIBUTES attributes{sizeof(attributes), nullptr, TRUE};
    HANDLE nul = INVALID_HANDLE_VALUE;
    if (!runCli) {
        nul = CreateFileW(L"NUL", GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
            &attributes, OPEN_EXISTING, 0, nullptr);
        if (nul == INVALID_HANDLE_VALUE) {
            CloseHandle(job);
            return 4;
        }
    }
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdInput = runCli ? input : nul;
    startup.hStdOutput = runCli ? output : nul;
    startup.hStdError = runCli ? errors : nul;
    PROCESS_INFORMATION child{};
    std::wstring command;
    LPCWSTR application = argv[1];
    LPCWSTR directory = argv[2];
    if (runCli) {
        application = argv[6];
        directory = argv[5];
        command = quoteArgument(argv[6]);
        for (int i = 7; i < argc; ++i) {
            command += L" " + quoteArgument(argv[i]);
        }
    } else {
        command = L"\"" + std::wstring(argv[1]) + L"\" serve --hostname 127.0.0.1 --port " + argv[3];
    }
    const BOOL created = CreateProcessW(application, command.data(), nullptr, nullptr, TRUE,
        CREATE_SUSPENDED | CREATE_NO_WINDOW, nullptr, directory, &startup, &child);
    if (nul != INVALID_HANDLE_VALUE) {
        CloseHandle(nul);
    }
    if (!created) {
        CloseHandle(job);
        return 5;
    }
    if (!AssignProcessToJobObject(job, child.hProcess) || ResumeThread(child.hThread) == DWORD(-1)) {
        TerminateProcess(child.hProcess, 1);
        CloseHandle(child.hThread);
        CloseHandle(child.hProcess);
        CloseHandle(job);
        return 6;
    }
    CloseHandle(child.hThread);
    FILETIME helperCreated{}, childCreated{}, exited{}, kernel{}, user{};
    BOOL validTimes = GetProcessTimes(GetCurrentProcess(), &helperCreated, &exited, &kernel, &user) &&
        GetProcessTimes(child.hProcess, &childCreated, &exited, &kernel, &user);
    if (!runTest) { CloseHandle(child.hProcess); }
    if (!validTimes) {
        TerminateJobObject(job, 1);
        return 6;
    }
    char identity[160]{};
    std::snprintf(identity, sizeof(identity), "%lu:%lu:%lu:%lu:%lu", helperCreated.dwHighDateTime, helperCreated.dwLowDateTime,
        child.dwProcessId, childCreated.dwHighDateTime, childCreated.dwLowDateTime);
    std::puts("ready");
    std::fflush(stdout);

    // Only a fresh connection presenting the capability can stop this job.
    bool connected = false;
    ULONGLONG connectedAt = 0;
    std::array<char, 65> request{};
    DWORD received = 0;
    bool replied = false;
    bool stopping = false;
    bool orphaned = false;
    for (;;) {
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info{};
        if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &info, sizeof(info), nullptr)) {
            CloseHandle(job);
            return 7;
        }
        if (info.ActiveProcesses == 0) {
            if (stopping) {
                DWORD written = 0;
                WriteFile(pipe, "stopped", 7, &written, nullptr);
                FlushFileBuffers(pipe);
            }
            DWORD exitCode = 0;
            if (runTest) {
                if (!GetExitCodeProcess(child.hProcess, &exitCode)) { exitCode = 9; }
                CloseHandle(child.hProcess);
            }
            CloseHandle(job);
            return static_cast<int>(exitCode);
        }
        if (parent && !orphaned && WaitForSingleObject(parent, 0) == WAIT_OBJECT_0) {
            // The Hub is gone: nobody can read this agent's output or cancel it any more.
            orphaned = true;
            TerminateJobObject(job, 1);
            continue;
        }
        if (!stopping && !connected) {
            const BOOL accepted = ConnectNamedPipe(pipe, nullptr);
            const DWORD error = accepted ? ERROR_SUCCESS : GetLastError();
            connected = accepted || error == ERROR_PIPE_CONNECTED;
            if (error == ERROR_NO_DATA) {
                DisconnectNamedPipe(pipe);
            }
            if (connected) {
                connectedAt = GetTickCount64();
                received = 0;
                replied = false;
            }
        }
        if (connected && replied && GetTickCount64() - connectedAt > 250) {
            DisconnectNamedPipe(pipe);
            connected = false;
        }
        if (connected && !stopping && !replied) {
            DWORD count = 0;
            const BOOL read = ReadFile(pipe, request.data() + received, static_cast<DWORD>(request.size()) - received, &count, nullptr);
            const DWORD error = read ? ERROR_SUCCESS : GetLastError();
            received += count;
            if (received == request.size()) {
                unsigned int difference = 0;
                for (size_t i = 0; i < 64; ++i) {
                    difference |= static_cast<unsigned char>(request[i] ^ control[i]);
                }
                if (difference == 0 && request[64] == 'i') {
                    DWORD written = 0;
                    WriteFile(pipe, identity, static_cast<DWORD>(std::string(identity).size()), &written, nullptr);
                    // Give the client time to read, then accept another connection.
                    replied = true;
                    continue;
                } else if (difference == 0 && request[64] == 'x') {
                    if (!TerminateJobObject(job, 0)) {
                        CloseHandle(job);
                        return 8;
                    }
                    stopping = true;
                    continue;
                }
            }
            if (received == request.size() || (error != ERROR_SUCCESS && error != ERROR_NO_DATA) ||
                GetTickCount64() - connectedAt > 2000) {
                DisconnectNamedPipe(pipe);
                connected = false;
            }
        }
        Sleep(50);
    }
}
