# Project-local launcher for Windows PowerShell and PowerShell 7.
$command = if ($args.Count) { $args[0] } else { 'help' }
$forward = @($args | Select-Object -Skip 1)
$botCommands = @('start', 'stop', 'restart', 'status', 'logs')

if ($command -cin @('help', '-h', '--help')) {
    Write-Output 'Usage: .\tpa.ps1 start|stop|restart|status|logs [lines]|follow|versions'
    Write-Output '       .\tpa.ps1 npm <arguments>'
    Write-Output '       .\tpa.ps1 calendar help'
    exit 0
}

if ($command -ceq 'calendar' -and
    ($forward.Count -eq 0 -or $forward[0] -cin @('help', '-h', '--help'))) {
    Write-Output 'Usage: .\tpa.ps1 calendar <command> [arguments]'
    Write-Output ''
    Get-Content -LiteralPath (Join-Path $PSScriptRoot 'scripts/tpa-calendar-help.txt')
    exit 0
}

if ($command -cnotin ($botCommands + @('calendar', 'follow', 'npm', 'versions'))) {
    [Console]::Error.WriteLine('Unknown command. Run .\tpa.ps1 help.')
    exit 2
}

Push-Location -LiteralPath $PSScriptRoot
try {
    if ($command -cin $botCommands) {
        & node.exe src/control.js $command @forward
    } elseif ($command -ceq 'calendar') {
        & node.exe --env-file=.env src/calendar-sync/manage.js @forward
    } elseif ($command -ceq 'follow') {
        $log = Join-Path $PSScriptRoot 'data/runtime/tobi.log'
        if (-not (Test-Path -LiteralPath $log -PathType Leaf)) {
            Write-Output 'No bot log yet. Start the bot first.'
            exit 0
        }
        Get-Content -LiteralPath $log -Encoding UTF8 -Tail 60 -Wait
        exit 0
    } elseif ($command -ceq 'npm') {
        & npm.cmd @forward
    } else {
        & node.exe --version
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        & npm.cmd --version
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        & codex.cmd --version
    }
    exit $LASTEXITCODE
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
} finally {
    Pop-Location
}
