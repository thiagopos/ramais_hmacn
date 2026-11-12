@echo off
REM Watchdog: garante que o supervisor do servidor VoIP esteja rodando.
REM Agendado a cada 5 min e no boot. Se o supervisor morreu, relanca.
REM Nao faz nada se ja houver uma instancia ativa (evita duplicar).

setlocal
cd /d "%~dp0.."

set NODEEXE=C:\Program Files\nodejs\node.exe
if not exist "%NODEEXE%" set NODEEXE=node

REM verifica via netstat se a porta 8181 esta sendo servida
netstat -ano -p TCP | findstr /R /C:"LISTENING" | findstr /C:":8181 " >nul
if %ERRORLEVEL%==0 (
  exit /b 0
)

echo [%DATE% %TIME%] porta 8181 sem resposta - relancando supervisor >> logs\watchdog.log
start "" /b "%NODEEXE%" "%~dp0supervisor.mjs"
exit /b 0
