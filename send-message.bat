@echo off
setlocal
cd /d "%~dp0"

where py >nul 2>&1
if errorlevel 1 (
  echo Python was not found.
  echo Install it from https://www.python.org/downloads/
  echo and tick "Add python.exe to PATH".
  pause
  exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
  echo First-time setup. This can take a minute.
  py -3 -m venv .venv
  if errorlevel 1 goto fail
  ".venv\Scripts\python.exe" -m pip install -r requirements.txt
  if errorlevel 1 goto fail
)

".venv\Scripts\python.exe" -c "import getpass,os,subprocess,sys; p=getpass.getpass('Passphrase (it will not be shown): '); m=input('Message: ').strip(); sys.exit(2) if (not p or not m) else None; os.environ['CHIEF_PASSPHRASE']=p; c=subprocess.call([sys.executable,'publish.py',m]); c=(subprocess.call([sys.executable,'publish.py','--new',m]) if (c and input('Type yes to start a new feed and remove the sample: ').strip().lower()=='yes') else c); sys.exit(c)"
set ERR=%ERRORLEVEL%
echo.
echo Next: on GitHub, use Add file, Upload files, and commit the new feed.json to main.
echo Upload only feed.json. Do not upload the .venv folder.
pause
exit /b %ERR%

:fail
echo Setup failed.
pause
exit /b 1
