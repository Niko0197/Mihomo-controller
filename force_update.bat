@echo off
set ROUTER_IP=192.168.1.1
set API_PORT=9090
set SECRET=

echo ====================================================
echo  Mihomo Subscription Instant Updater
echo ====================================================
echo.
echo Sending update signals to router %ROUTER_IP%:%API_PORT%...
echo.

if "%SECRET%"=="" (
    curl -w "stealthsurf:      HTTP %%{http_code}\n" -s -o NUL -X PUT "http://%ROUTER_IP%:%API_PORT%/providers/proxies/stealthsurf"
    curl -w "Igareck_Black:    HTTP %%{http_code}\n" -s -o NUL -X PUT "http://%ROUTER_IP%:%API_PORT%/providers/proxies/Igareck_Black_VPN"
) else (
    curl -w "stealthsurf:      HTTP %%{http_code}\n" -s -o NUL -H "Authorization: Bearer %SECRET%" -X PUT "http://%ROUTER_IP%:%API_PORT%/providers/proxies/stealthsurf"
    curl -w "Igareck_Black:    HTTP %%{http_code}\n" -s -o NUL -H "Authorization: Bearer %SECRET%" -X PUT "http://%ROUTER_IP%:%API_PORT%/providers/proxies/Igareck_Black_VPN"
)

echo.
echo ----------------------------------------------------
echo Done! All active proxy providers are being reloaded in-memory.
echo ----------------------------------------------------
echo.
pause
