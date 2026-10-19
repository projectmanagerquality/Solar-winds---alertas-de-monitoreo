# ==============================================================================
#  UFINET - DESPLIEGUE AUTOMATIZADO DE ALERTAS ORION A WHATSAPP   (v2.0)
#  Ubicacion estandar de despliegue: C:\UfinetOrionBot
#  Desarrollado por: StinkyPinky
#
#  Uso (PowerShell como Administrador):
#     powershell -ExecutionPolicy Bypass -File .\setup_and_run.ps1
#     powershell -ExecutionPolicy Bypass -File .\setup_and_run.ps1 -Service Yes
#     powershell -ExecutionPolicy Bypass -File .\setup_and_run.ps1 -Service No
#
#  Parametro -Service:  Ask (por defecto, pregunta) | Yes (instala/actualiza el
#  servicio sin preguntar) | No (solo instala dependencias y arranca en consola).
#
#  NOTA: este archivo es ASCII a proposito (sin acentos) para que Windows
#  PowerShell 5.1 lo lea bien sin importar la codificacion con que se guarde.
# ==============================================================================

[CmdletBinding()]
param(
    [ValidateSet('Ask', 'Yes', 'No')]
    [string]$Service = 'Ask'
)

$ErrorActionPreference = 'Stop'

$TargetDir      = 'C:\UfinetOrionBot'
$ServiceName    = 'UfinetOrionWhatsAppBot'
$ScriptName     = 'ufinet_orion_whatsapp.js'
$ProjectFiles   = @('ufinet_orion_whatsapp.js', 'setup_and_run.ps1', 'README.md', 'package.json', 'package-lock.json', '.gitignore')
$NeededPackages = @('whatsapp-web.js', 'qrcode-terminal', 'axios')

function Write-Info($msg) { Write-Host $msg -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "[OK] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "[AVISO] $msg" -ForegroundColor Yellow }
function Write-Step($msg) { Write-Host "`n$msg" -ForegroundColor Yellow }

function Test-IsAdmin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Copy-ProjectFiles {
    if (-not $PSScriptRoot) { throw 'Ejecute este script desde un archivo .ps1 (no pegado en la consola).' }

    $src = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\')
    $dst = [IO.Path]::GetFullPath($TargetDir).TrimEnd('\')

    if (-not (Test-Path $TargetDir)) {
        New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null
        Write-Ok "Carpeta '$TargetDir' creada."
    }

    if ($src -ieq $dst) {
        Write-Ok "Los archivos ya se encuentran en '$TargetDir'."
        return
    }

    Write-Info "Copiando archivos del proyecto a '$TargetDir'..."
    foreach ($f in $ProjectFiles) {
        $p = Join-Path $src $f
        if (Test-Path $p) { Copy-Item -Path $p -Destination $dst -Force }
    }
    Write-Ok 'Archivos copiados (la configuracion, el estado y la sesion de WhatsApp existentes se conservan).'
}

function Get-NodePath {
    $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $cmd) {
        throw "Node.js no esta instalado. Instale Node.js LTS (18 o superior) desde https://nodejs.org/ o con: winget install OpenJS.NodeJS.LTS"
    }
    $ver = (& $cmd.Source -v).Trim()
    $major = [int]($ver.TrimStart('v').Split('.')[0])
    if ($major -lt 18) {
        throw "Se requiere Node.js 18 o superior (detectado $ver). Actualice Node.js LTS."
    }
    Write-Ok "Node.js detectado ($ver)."
    return $cmd.Source
}

function Install-Dependencies {
    $npmCmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npmCmd) { throw 'No se encontro npm.cmd. Reinstale Node.js LTS.' }
    $npm = $npmCmd.Source

    Push-Location $TargetDir
    try {
        if (-not (Test-Path 'package.json')) {
            & $npm init -y | Out-Null
            if ($LASTEXITCODE -ne 0) { throw 'npm init fallo.' }
        }

        $pkg = Get-Content -Path 'package.json' -Raw | ConvertFrom-Json
        $have = @()
        if ($pkg.dependencies) { $have = @($pkg.dependencies.PSObject.Properties.Name) }
        $missing = @($NeededPackages | Where-Object { $have -notcontains $_ })

        if ($missing.Count -gt 0) {
            Write-Info ("Instalando (version exacta): " + ($missing -join ', '))
            & $npm install --save-exact --no-audit --no-fund @missing
            if ($LASTEXITCODE -ne 0) { throw 'npm install fallo. Revise la conexion a internet.' }
        } else {
            Write-Info 'Verificando dependencias segun package.json / package-lock.json...'
            & $npm install --no-audit --no-fund
            if ($LASTEXITCODE -ne 0) { throw 'npm install fallo. Revise la conexion a internet.' }
        }

        foreach ($p in $NeededPackages) {
            if (-not (Test-Path (Join-Path $TargetDir "node_modules\$p"))) {
                throw "La dependencia '$p' no quedo instalada."
            }
            Write-Ok "Paquete '$p' verificado."
        }
    }
    finally {
        Pop-Location
    }
}

function Protect-ConfigFile {
    $cfg = Join-Path $TargetDir 'ufinet_config.json'
    if (-not (Test-Path $cfg)) { return }

    $me = "$env:USERDOMAIN\$env:USERNAME"
    & icacls.exe $cfg /grant:r "${me}:(F)" /grant:r '*S-1-5-18:(F)' /grant:r '*S-1-5-32-544:(F)' /inheritance:r | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Warn 'No se pudieron restringir los permisos de ufinet_config.json.'
    } else {
        Write-Ok 'Permisos de ufinet_config.json restringidos (SYSTEM, Administradores y usuario actual).'
    }
}

function New-DesktopShortcut {
    $desktop = [Environment]::GetFolderPath('Desktop')
    $path = Join-Path $desktop 'Ufinet Orion WhatsApp Bot.lnk'

    $shell = New-Object -ComObject WScript.Shell
    $lnk = $shell.CreateShortcut($path)
    $lnk.TargetPath = "$env:SystemRoot\System32\cmd.exe"
    $lnk.Arguments = "/k node `"$TargetDir\$ScriptName`""
    $lnk.WorkingDirectory = $TargetDir
    $lnk.Description = 'Arrancar Bot de Alertas UFINET Orion WhatsApp (por StinkyPinky)'
    $lnk.Save()
    Write-Ok "Acceso directo 'Ufinet Orion WhatsApp Bot' creado en el Escritorio."
}

function Update-SessionPath {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = (@($machine, $user) | Where-Object { $_ }) -join ';'
}

function Find-NssmExe {
    $local = Join-Path $TargetDir 'tools\nssm.exe'
    if (Test-Path $local) { return $local }

    $cmd = Get-Command nssm.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }

    $roots = @(
        (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'),
        (Join-Path $env:ProgramFiles 'WinGet\Packages'),
        (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links'),
        (Join-Path $env:ProgramFiles 'WinGet\Links'),
        (Join-Path $env:ProgramData 'chocolatey\lib\nssm'),
        (Join-Path $env:ProgramData 'chocolatey\bin')
    )
    $found = @()
    foreach ($r in $roots) {
        if (Test-Path $r) {
            $found += @(Get-ChildItem -Path $r -Filter 'nssm.exe' -Recurse -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName)
        }
    }
    $found = @($found | Where-Object { $_ })
    if ($found.Count -eq 0) { return $null }

    $win64 = $found | Where-Object { $_ -match 'win64' } | Select-Object -First 1
    if ($win64) { return $win64 }
    return ($found | Select-Object -First 1)
}

function Install-NssmViaPackageManager {
    $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
    if ($winget) {
        Write-Info 'Instalando NSSM con winget (NSSM.NSSM)...'
        try {
            & $winget.Source install --id NSSM.NSSM -e --silent --accept-source-agreements --accept-package-agreements
        } catch {
            Write-Warn "winget no pudo instalar NSSM: $($_.Exception.Message)"
        }
        Update-SessionPath
        $p = Find-NssmExe
        if ($p) { return $p }
    }

    $choco = Get-Command choco.exe -ErrorAction SilentlyContinue
    if ($choco) {
        Write-Info 'Instalando NSSM con Chocolatey (nssm)...'
        try {
            & $choco.Source install nssm -y --no-progress
        } catch {
            Write-Warn "Chocolatey no pudo instalar NSSM: $($_.Exception.Message)"
        }
        Update-SessionPath
        $p = Find-NssmExe
        if ($p) { return $p }
    }

    return $null
}

function Resolve-Nssm {
    $p = Find-NssmExe
    if (-not $p) { $p = Install-NssmViaPackageManager }
    if (-not $p) { return $null }

    # Se copia dentro del proyecto para que el servicio no dependa de rutas de perfil de usuario.
    $toolsDir = Join-Path $TargetDir 'tools'
    if (-not (Test-Path $toolsDir)) { New-Item -ItemType Directory -Path $toolsDir -Force | Out-Null }
    $dest = Join-Path $toolsDir 'nssm.exe'
    if ($p -ine $dest) { Copy-Item -Path $p -Destination $dest -Force }
    return $dest
}

function Install-NssmService {
    param([string]$Nssm, [string]$NodePath)

    $scriptPath = Join-Path $TargetDir $ScriptName
    $logDir = Join-Path $TargetDir 'logs'
    if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

    # Si habia una tarea programada de respaldo, se elimina para no duplicar instancias.
    $oldTask = Get-ScheduledTask -TaskName $ServiceName -ErrorAction SilentlyContinue
    if ($oldTask) {
        Stop-ScheduledTask -TaskName $ServiceName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $ServiceName -Confirm:$false
    }

    $exists = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($exists) {
        Write-Info "Servicio '$ServiceName' existente: deteniendo para actualizar..."
        & $Nssm stop $ServiceName | Out-Null
    } else {
        Write-Info "Registrando servicio '$ServiceName'..."
        & $Nssm install $ServiceName $NodePath $scriptPath | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "NSSM no pudo registrar el servicio (codigo $LASTEXITCODE)." }
    }

    $settings = @(
        @('set', $ServiceName, 'Application', $NodePath),
        @('set', $ServiceName, 'AppParameters', $scriptPath),
        @('set', $ServiceName, 'AppDirectory', $TargetDir),
        @('set', $ServiceName, 'DisplayName', 'Ufinet Orion WhatsApp Bot'),
        @('set', $ServiceName, 'Description', 'Alertas de SolarWinds Orion hacia WhatsApp (Ufinet Nicaragua) - StinkyPinky'),
        @('set', $ServiceName, 'Start', 'SERVICE_DELAYED_AUTO_START'),
        @('set', $ServiceName, 'AppStdout', (Join-Path $logDir 'service_stdout.log')),
        @('set', $ServiceName, 'AppStderr', (Join-Path $logDir 'service_stderr.log')),
        @('set', $ServiceName, 'AppRotateFiles', '1'),
        @('set', $ServiceName, 'AppRotateOnline', '1'),
        @('set', $ServiceName, 'AppRotateBytes', '5242880'),
        @('set', $ServiceName, 'AppExit', 'Default', 'Restart'),
        @('set', $ServiceName, 'AppRestartDelay', '15000'),
        @('set', $ServiceName, 'AppThrottle', '5000'),
        @('set', $ServiceName, 'AppStopMethodConsole', '15000')
    )
    foreach ($s in $settings) {
        & $Nssm @s | Out-Null
        if ($LASTEXITCODE -ne 0) { Write-Warn ("nssm " + ($s -join ' ') + " devolvio codigo $LASTEXITCODE") }
    }

    & $Nssm start $ServiceName | Out-Null
    Start-Sleep -Seconds 5
    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($svc -and $svc.Status -eq 'Running') {
        Write-Ok "Servicio '$ServiceName' en ejecucion (inicio automatico retrasado, reinicio automatico ante fallos)."
    } else {
        Write-Warn "El servicio no quedo en ejecucion. Revise $logDir\service_stderr.log y $logDir\ufinet_bot.log"
    }
}

function Install-ScheduledTaskFallback {
    param([string]$NodePath)

    $scriptPath = Join-Path $TargetDir $ScriptName

    $existing = Get-ScheduledTask -TaskName $ServiceName -ErrorAction SilentlyContinue
    if ($existing) { Stop-ScheduledTask -TaskName $ServiceName -ErrorAction SilentlyContinue }

    $action = New-ScheduledTaskAction -Execute $NodePath -Argument "`"$scriptPath`"" -WorkingDirectory $TargetDir
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
        -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew

    Register-ScheduledTask -TaskName $ServiceName -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
        -Description 'Alertas de SolarWinds Orion hacia WhatsApp (Ufinet Nicaragua) - StinkyPinky' -Force | Out-Null
    Start-ScheduledTask -TaskName $ServiceName

    Write-Ok "Tarea programada '$ServiceName' creada (inicia con el sistema, SYSTEM, reintenta cada minuto si falla)."
    Write-Info 'Los registros del bot estan en C:\UfinetOrionBot\logs\ufinet_bot.log'
}

function Main {
    if (-not (Test-IsAdmin)) {
        throw 'Debe ejecutar este script como Administrador en PowerShell.'
    }

    Write-Host '==================================================================' -ForegroundColor Cyan
    Write-Host '   UFINET - INSTALADOR DE BOT DE ALERTAS ORION WHATSAPP (v2.0)' -ForegroundColor Cyan
    Write-Host '   Hecho por StinkyPinky' -ForegroundColor Cyan
    Write-Host '==================================================================' -ForegroundColor Cyan

    Write-Step '[1/5] Preparando archivos...'
    Copy-ProjectFiles
    Set-Location $TargetDir

    Write-Step '[2/5] Verificando Node.js...'
    $nodePath = Get-NodePath

    Write-Step '[3/5] Verificando dependencias...'
    Install-Dependencies
    Protect-ConfigFile

    Write-Step '[4/5] Creando acceso directo en el Escritorio...'
    New-DesktopShortcut

    Write-Step '[5/5] Configuracion de ejecucion en segundo plano'
    $wantService = $false
    switch ($Service) {
        'Yes' { $wantService = $true }
        'No'  { $wantService = $false }
        default {
            $answer = Read-Host 'Desea instalar/actualizar el servicio automatico de Windows UfinetOrionWhatsAppBot? (S/N)'
            $wantService = ($answer -match '^[sSyY]')
        }
    }

    $firstRun = $false
    if ($wantService) {
        $hasConfig = Test-Path (Join-Path $TargetDir 'ufinet_config.json')
        $hasSession = Test-Path (Join-Path $TargetDir '.wwebjs_auth\session')
        if (-not ($hasConfig -and $hasSession)) {
            Write-Warn 'Aun no hay configuracion y/o sesion de WhatsApp vinculada. El servicio no puede pedir datos ni mostrar el QR.'
            Write-Warn 'Se iniciara el bot en consola para configurarlo. Cuando vea "Cliente de WhatsApp conectado y listo", presione Ctrl+C y vuelva a ejecutar este script con -Service Yes.'
            $wantService = $false
            $firstRun = $true
        }
    }

    if ($wantService) {
        $nssm = Resolve-Nssm
        if ($nssm) {
            Install-NssmService -Nssm $nssm -NodePath $nodePath
        } else {
            Write-Warn 'No se pudo obtener NSSM (ni winget ni Chocolatey disponibles, y no existe tools\nssm.exe).'
            Write-Warn 'Se usara el Programador de tareas de Windows como alternativa. Si prefiere NSSM, copie nssm.exe a C:\UfinetOrionBot\tools\ y ejecute de nuevo con -Service Yes.'
            Install-ScheduledTaskFallback -NodePath $nodePath
        }
        Write-Host "`nComandos utiles:  Get-Service $ServiceName   |   Get-Content C:\UfinetOrionBot\logs\ufinet_bot.log -Tail 50 -Wait" -ForegroundColor Magenta
        return
    }

    # Ejecucion interactiva en consola
    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    $task = Get-ScheduledTask -TaskName $ServiceName -ErrorAction SilentlyContinue
    if (($svc -and $svc.Status -eq 'Running') -or ($task -and $task.State -eq 'Running')) {
        Write-Warn "El bot ya esta en ejecucion como servicio/tarea. Detengalo antes de usar la consola interactiva (Stop-Service $ServiceName  o  Stop-ScheduledTask $ServiceName)."
        return
    }

    if (-not $firstRun) { Write-Info 'Iniciando bot en consola interactiva (Ctrl+C para detener)...' }
    else { Write-Info 'Iniciando bot en consola interactiva para la configuracion inicial...' }
    & $nodePath (Join-Path $TargetDir $ScriptName)
    Protect-ConfigFile
}

try {
    Main
    exit 0
}
catch {
    Write-Host "`n[ERROR UFINET] $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
