@echo off
REM Sobe o servidor de monitoramento VoIP sem janela (usado pela tarefa agendada)
REM e tambem pelo monitoramento periodico.
chcp 65001 >nul
cd /d "%~dp0"
set NODE_NO_WARNINGS=1

set PORT=%1
if "%PORT%"=="" set PORT=8181

set HOST=%2
if "%HOST%"=="" set HOST=127.0.0.1

node scripts\run-server.mjs --port %PORT% --host %HOST%
