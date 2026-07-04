@echo off
REM Omniforge daemon launcher (Windows). Double-click ou rode no terminal:
REM   - Detached: sobrevive ao prompt fechar (config interna do daemon).
REM   - Logs: data\daemon.log
REM   - Token: data\daemon-token.txt (sincronizado em .env)
REM
REM Uso pelo Task Scheduler / Startup folder: aponte o "Programa" pra este
REM arquivo. Sem argumentos.

setlocal
cd /d "%~dp0\.."

call .\bin\omniforge.cmd daemon status >nul 2>&1
if %errorlevel%==0 (
  echo Daemon ja esta rodando. Status:
  call .\bin\omniforge.cmd daemon status
  goto :end
)

echo Iniciando Omniforge daemon...
call .\bin\omniforge.cmd daemon start
if %errorlevel% neq 0 (
  echo ERRO: daemon start falhou. Veja data\daemon.log
  exit /b 1
)

echo.
echo URL do dashboard:
for /f "delims=" %%t in (data\daemon-token.txt) do set TOKEN=%%t
echo   http://127.0.0.1:20129/dashboard?token=%TOKEN%
echo.
echo (Cookie persiste 30 dias — proxima vez voce abre /dashboard direto)

:end
endlocal
