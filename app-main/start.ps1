# Demarre MongoDB, backend, frontend et bot Discord en une seule fois.
# A placer dans le dossier qui contient "backend" et "frontend" (app-main\app-main).

$ErrorActionPreference = 'Continue'
$Root = $PSScriptRoot

# --- Optionnel : si le bot n'est pas trouve tout seul, mets ici le dossier qui contient bot.py ---
$BotDir = 'C:\SkyBot'

$BackendDir  = Join-Path $Root 'backend'
$FrontendDir = Join-Path $Root 'frontend'
$Problems = New-Object System.Collections.ArrayList

function Test-Port([int]$Port) {
    try {
        $c = New-Object System.Net.Sockets.TcpClient
        $c.Connect('127.0.0.1', $Port)
        $c.Close()
        return $true
    } catch { return $false }
}

function Wait-Port([int]$Port, [int]$TimeoutSec) {
    $t = 0
    while (-not (Test-Port $Port)) {
        Start-Sleep -Seconds 1
        $t++
        if ($t -ge $TimeoutSec) { return $false }
    }
    return $true
}

function Start-Tab([string]$Title, [string]$Dir, [string]$Cmd) {
    $full = "`$Host.UI.RawUI.WindowTitle = '$Title'; Set-Location -LiteralPath '$Dir'; $Cmd"
    Start-Process powershell -ArgumentList '-NoExit', '-ExecutionPolicy', 'Bypass', '-Command', $full | Out-Null
}

function Add-Problem([string]$Msg) {
    [void]$Problems.Add($Msg)
    Write-Host "  [!] $Msg" -ForegroundColor Red
}

function Find-Mongod {
    $cmd = Get-Command mongod -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $pats = @(
        'C:\Program Files\MongoDB\Server\*\bin\mongod.exe',
        'C:\Program Files (x86)\MongoDB\Server\*\bin\mongod.exe',
        'C:\MongoDB\bin\mongod.exe',
        'C:\mongodb\bin\mongod.exe',
        "$env:LOCALAPPDATA\Programs\MongoDB\Server\*\bin\mongod.exe"
    )
    foreach ($p in $pats) {
        $f = Get-ChildItem $p -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1
        if ($f) { return $f.FullName }
    }
    return ''
}

# ---------------- 1. MongoDB ----------------
Write-Host '[1/4] MongoDB...' -ForegroundColor Cyan
if (Test-Port 27017) {
    Write-Host '  deja demarre (rien a faire, pas de fenetre dediee)' -ForegroundColor Green
} else {
    $svc = Get-Service | Where-Object { $_.Name -like '*mongo*' } | Select-Object -First 1
    if ($svc) {
        Write-Host "  service Windows trouve : $($svc.Name)"
        try { Start-Service -Name $svc.Name -ErrorAction Stop }
        catch {
            Write-Host '  droits administrateur requis : accepte la fenetre Windows qui va s''ouvrir...' -ForegroundColor Yellow
            try {
                Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile', '-Command', "Start-Service -Name '$($svc.Name)'"
            } catch { Add-Problem 'Impossible de demarrer le service MongoDB (UAC refuse ?).' }
        }
    } else {
        $mongod = Find-Mongod
        if ($mongod) {
            if (Test-Path 'C:\data\db') { $dataDir = 'C:\data\db' } else { $dataDir = Join-Path $Root 'mongo-data' }
            New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
            Write-Host "  mongod : $mongod"
            Write-Host "  donnees : $dataDir"
            Start-Tab 'MongoDB' $Root "& '$mongod' --dbpath '$dataDir' --bind_ip 127.0.0.1 --port 27017"
        } else {
            Add-Problem 'MongoDB introuvable (ni service, ni mongod.exe). Installe MongoDB Community Server ou lance-le a la main.'
        }
    }
    if (Wait-Port 27017 30) { Write-Host '  OK' -ForegroundColor Green }
    elseif ($Problems.Count -eq 0) { Add-Problem 'MongoDB ne repond pas sur le port 27017 apres 30 s.' }
}

# ---------------- 2. Backend ----------------
Write-Host '[2/4] Backend (port 8001)...' -ForegroundColor Cyan
if (Test-Port 8001) {
    Write-Host '  deja demarre' -ForegroundColor Green
} else {
    $py = Join-Path $BackendDir '.venv\Scripts\python.exe'
    if (-not (Test-Path $py)) { $py = 'python' }
    Start-Tab 'Backend 8001' $BackendDir "& '$py' -m uvicorn server:app --host 127.0.0.1 --port 8001"
    if (Wait-Port 8001 40) { Write-Host '  OK' -ForegroundColor Green }
    else { Add-Problem 'Backend : le port 8001 ne repond pas (regarde la fenetre "Backend 8001").' }
}

# ---------------- 3. Frontend ----------------
Write-Host '[3/4] Frontend (port 3000)...' -ForegroundColor Cyan
if (Test-Port 3000) {
    Write-Host '  deja demarre' -ForegroundColor Green
} else {
    $cmd = '$env:DISABLE_VISUAL_EDITS = ''true''; npm run dev'
    if (-not (Test-Path (Join-Path $FrontendDir 'node_modules'))) { $cmd = 'npm install; ' + $cmd }
    Start-Tab 'Frontend 3000' $FrontendDir $cmd
    if (Wait-Port 3000 90) { Write-Host '  OK' -ForegroundColor Green }
    else { Add-Problem 'Frontend : le port 3000 ne repond pas (regarde la fenetre "Frontend 3000").' }
}

# ---------------- 4. Bot Discord ----------------
Write-Host '[4/4] Bot Discord...' -ForegroundColor Cyan
if (Test-Port 8080) {
    Write-Host '  deja demarre (API du bot sur 8080)' -ForegroundColor Green
} elseif (-not (Test-Path (Join-Path $BotDir 'bot.py'))) {
    Add-Problem "bot.py introuvable dans $BotDir"
} else {
    Start-Tab 'Bot Discord' $BotDir 'python bot.py'
    Write-Host "  lance : python bot.py dans $BotDir" -ForegroundColor Green
}

# ---------------- Resume ----------------
Write-Host ''
if ($Problems.Count -eq 0) {
    Write-Host 'Tout est lance. Ouvre http://127.0.0.1:3000' -ForegroundColor Green
    Start-Process 'http://127.0.0.1:3000'
} else {
    Write-Host 'Certains elements posent probleme :' -ForegroundColor Yellow
    foreach ($p in $Problems) { Write-Host "  - $p" -ForegroundColor Yellow }
}
Write-Host ''
Write-Host 'Pour arreter : ferme chaque fenetre (ou Ctrl+C dedans).'
Read-Host 'Appuie sur Entree pour fermer cette fenetre'
