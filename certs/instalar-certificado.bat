@echo off
setlocal EnableExtensions EnableDelayedExpansion
title Instalar Certificado HMACN Acesso

rem ===========================================================================
rem  instalar-certificado.bat
rem  Instala a AUTORIDADE CERTIFICADORA (CA) do HMACN Acesso nesta maquina, para
rem  usar HTTPS em QUALQUER navegador: Chrome, Edge e Firefox.
rem
rem  IMPORTANTE: o arquivo instalado e o ca.crt (a CA) — NAO o certificado do
rem  servidor. E a CA que faz o navegador confiar no certificado do servidor.
rem  (O certificado antigo era um certificado de AUTORIDADE usado como
rem  certificado de servidor: o Firefox recusava com o erro
rem  MOZILLA_PKIX_ERROR_CA_CERT_USED_AS_END_ENTITY.)
rem
rem  O que faz:
rem   1) Windows Root store  -> confia no Chrome e no Edge.
rem   2) Firefox: politica ImportEnterpriseRoots (Registro HKLM + policies.json)
rem      -> o Firefox passa a confiar nas raizes do Windows.
rem
rem  Como usar: clique com o botao direito e escolha
rem  "Executar como administrador". Mantenha o ca.crt nesta mesma pasta.
rem ===========================================================================

rem --- Auto-elevacao: se nao for admin, reabre elevado -----------------------
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Solicitando privilegios de administrador...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

rem --- Localiza o certificado na pasta deste .bat ----------------------------
set "PASTA=%~dp0"
set "CERT="
rem A CA vem primeiro: e ela que o navegador precisa confiar.
if exist "%PASTA%ca.crt" set "CERT=%PASTA%ca.crt"
if not defined CERT if exist "%PASTA%cert.pem" set "CERT=%PASTA%cert.pem"
if not defined CERT if exist "%PASTA%cert.crt" set "CERT=%PASTA%cert.crt"
if not defined CERT if exist "%PASTA%certificado.cer" set "CERT=%PASTA%certificado.cer"

if not defined CERT (
  echo.
  echo [ERRO] Nao encontrei o certificado nesta pasta:
  echo        %PASTA%
  echo        Coloque o ca.crt junto deste .bat e rode de novo.
  echo.
  pause
  exit /b 1
)

echo.
echo ============================================================
echo   INSTALACAO DO CERTIFICADO - HMACN Acesso
echo ============================================================
echo   Certificado: %CERT%
echo.

rem --- 1) Windows Root store (Chrome / Edge) ---------------------------------
echo [1/3] Instalando no repositorio raiz do Windows...
certutil -addstore -f Root "%CERT%" >nul 2>&1
if errorlevel 1 (
  echo       [FALHA] Nao foi possivel instalar no Root store do Windows.
  echo       Detalhe do erro:
  certutil -addstore -f Root "%CERT%"
) else (
  echo       [OK] Instalado no Root store - Chrome e Edge confiam.
)

rem --- 2) Firefox: politica de raizes da empresa -----------------------------
echo.
echo [2/3] Configurando o Firefox...
set "FF_OK_REG=0"
set "FF_OK_JSON=0"

rem 2a) Politica via Registro (HKLM)
reg add "HKLM\SOFTWARE\Policies\Mozilla\Firefox\Certificates" /v ImportEnterpriseRoots /t REG_DWORD /d 1 /f >nul 2>&1
if errorlevel 1 (
  echo       [AVISO] Nao consegui gravar a politica no Registro.
) else (
  set "FF_OK_REG=1"
  echo       [OK] Politica aplicada no Registro do Windows.
)

rem 2b) Politica via policies.json
set "FF_DIR="
if exist "%ProgramFiles%\Mozilla Firefox\firefox.exe" set "FF_DIR=%ProgramFiles%\Mozilla Firefox"
if not defined FF_DIR if exist "%ProgramFiles(x86)%\Mozilla Firefox\firefox.exe" set "FF_DIR=%ProgramFiles(x86)%\Mozilla Firefox"
if not defined FF_DIR if exist "%LOCALAPPDATA%\Mozilla Firefox\firefox.exe" set "FF_DIR=%LOCALAPPDATA%\Mozilla Firefox"

if not defined FF_DIR (
  echo       [INFO] Firefox nao encontrado nesta maquina.
) else (
  if not exist "%FF_DIR%\distribution" mkdir "%FF_DIR%\distribution" >nul 2>&1
  > "%FF_DIR%\distribution\policies.json" echo {
  >>"%FF_DIR%\distribution\policies.json" echo   "policies": {
  >>"%FF_DIR%\distribution\policies.json" echo     "Certificates": {
  >>"%FF_DIR%\distribution\policies.json" echo       "ImportEnterpriseRoots": true
  >>"%FF_DIR%\distribution\policies.json" echo     }
  >>"%FF_DIR%\distribution\policies.json" echo   }
  >>"%FF_DIR%\distribution\policies.json" echo }
  if exist "%FF_DIR%\distribution\policies.json" (
    set "FF_OK_JSON=1"
    echo       [OK] Configuracao gravada em: %FF_DIR%\distribution\policies.json
  ) else (
    echo       [AVISO] Nao consegui gravar o policies.json em %FF_DIR%.
  )
)

rem --- 3) Conferencia: a CA esta mesmo no repositorio? ---------------------
echo.
echo [3/3] Conferindo a instalacao...
certutil -store Root | findstr /I /C:"HMACN Acesso" >nul 2>&1
if errorlevel 1 (
  echo       [ATENCAO] A CA NAO foi encontrada no repositorio raiz do Windows.
  echo       Rode este .bat de novo como administrador.
) else (
  echo       [OK] CA encontrada no repositorio raiz do Windows.
)

rem --- Resumo -----------------------------------------------------------------
echo.
echo ============================================================
echo   CONCLUIDO
echo ============================================================
if "%FF_OK_REG%%FF_OK_JSON%"=="00" (
  echo   Windows instalado. Firefox NAO configurado.
) else (
  echo   Windows instalado. Firefox configurado.
)
echo.
echo   IMPORTANTE: feche e reabra TODOS os navegadores para o aviso desaparecer.
echo   No Firefox, para confirmar, veja em:
echo     Menu ^> Configuracoes ^> Privacidade e Seguranca ^> Certificados
echo     ^> Autoridades ^> procure por "HMACN Acesso - Autoridade Certificadora Local"
echo.
echo   Acesse o sistema por: https://smshmacn007.rede.sp
echo.
pause
exit /b 0
