@echo off
schtasks /create /tn "HydraTracker" /tr "wscript.exe \"C:\Users\AravindVijayaSarathy\Desktop\hydra-tracker\start-hydra.vbs\"" /sc ONLOGON /rl HIGHEST /f
if %ERRORLEVEL% EQU 0 (
    echo Task registered successfully. HydraTracker will start at next login.
) else (
    echo Failed to register task. Make sure you ran this as Administrator.
)
pause
