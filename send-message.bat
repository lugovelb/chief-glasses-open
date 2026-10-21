@echo off
setlocal
cd /d "%~dp0"

set "PY="
where py >nul 2>&1
if not errorlevel 1 set "PY=py -3"
if not defined PY (
  where python >nul 2>&1
  if not errorlevel 1 set "PY=python"
)
if not defined PY (
  echo Python was not found.
  echo Install it from https://www.python.org/downloads/
  echo and tick "Add python.exe to PATH".
  pause
  exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
  echo First-time setup. This can take a minute.
  %PY% -m venv .venv
  if errorlevel 1 goto venvfail
  ".venv\Scripts\python.exe" -m pip install -r requirements.txt
  if errorlevel 1 goto venvfail
)
goto run

:venvfail
if exist ".venv" rmdir /s /q ".venv"
echo Could not install what the send script needs. The unfinished toolbox folder was removed.
pause
exit /b 1

:run
".venv\Scripts\python.exe" publish.py --interactive
set ERR=%ERRORLEVEL%
if not "%ERR%"=="0" goto done
echo.
echo Next: on GitHub, use Add file, Upload files, and commit the new feed.json to main.
echo Upload only feed.json. Do not upload the .venv folder.
:done
echo.
pause
exit /b %ERR%
