@echo off
setlocal
set "vswhere=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%vswhere%" exit /b 1
for /f "usebackq delims=" %%i in (`"%vswhere%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "vs=%%i"
if not defined vs exit /b 1
call "%vs%\VC\Auxiliary\Build\vcvars64.bat" >nul
if errorlevel 1 exit /b 1
if not exist "%~dp0..\dist" mkdir "%~dp0..\dist"
cl /nologo /std:c++17 /EHsc /W4 /WX /MT /O2 /Fo"%~dp0..\dist\job.obj" /Fe"%~dp0..\dist\singularity-job.exe" "%~dp0job.cpp"
if errorlevel 1 exit /b 1
del "%~dp0..\dist\job.obj"
