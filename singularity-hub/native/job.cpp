#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <cstdio>
#include <string>

int wmain(int argc, wchar_t** argv) {
    if (argc != 4 || std::wstring(argv[3]).find_first_not_of(L"0123456789") != std::wstring::npos) {
        return 2;
    }
    HANDLE job = CreateJobObjectW(nullptr, nullptr);
    if (!job) {
        return 3;
    }

    // Only the NUL handle is inherited by OpenCode. Its output can contain credentials.
    const HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
    SetHandleInformation(input, HANDLE_FLAG_INHERIT, 0);
    SetHandleInformation(GetStdHandle(STD_OUTPUT_HANDLE), HANDLE_FLAG_INHERIT, 0);
    SetHandleInformation(GetStdHandle(STD_ERROR_HANDLE), HANDLE_FLAG_INHERIT, 0);
    SECURITY_ATTRIBUTES attributes{sizeof(attributes), nullptr, TRUE};
    HANDLE nul = CreateFileW(L"NUL", GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
        &attributes, OPEN_EXISTING, 0, nullptr);
    if (nul == INVALID_HANDLE_VALUE) {
        CloseHandle(job);
        return 4;
    }
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdInput = startup.hStdOutput = startup.hStdError = nul;
    PROCESS_INFORMATION child{};
    std::wstring command = L"\"" + std::wstring(argv[1]) + L"\" serve --hostname 127.0.0.1 --port " + argv[3];
    const BOOL created = CreateProcessW(argv[1], command.data(), nullptr, nullptr, TRUE,
        CREATE_SUSPENDED | CREATE_NO_WINDOW, nullptr, argv[2], &startup, &child);
    CloseHandle(nul);
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
    CloseHandle(child.hProcess);
    std::puts("ready");
    std::fflush(stdout);

    // A disconnected Hub does not authorize killing a running session.
    bool connected = true;
    bool stopping = false;
    for (;;) {
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info{};
        if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &info, sizeof(info), nullptr)) {
            CloseHandle(job);
            return 7;
        }
        if (info.ActiveProcesses == 0) {
            CloseHandle(job);
            return 0;
        }
        DWORD available = 0;
        if (connected && !PeekNamedPipe(input, nullptr, 0, nullptr, &available, nullptr)) {
            connected = false;
        }
        if (connected && !stopping && available) {
            char commandByte{};
            DWORD read = 0;
            if (ReadFile(input, &commandByte, sizeof(commandByte), &read, nullptr) && read && commandByte == 'x') {
                if (!TerminateJobObject(job, 0)) {
                    CloseHandle(job);
                    return 8;
                }
                stopping = true;
            }
        }
        Sleep(50);
    }
}
