$path = 'C:\Users\HuWencan\Documents\deepseek-harness\default-workspace\tools\voicekeys\runtime\worker.ps1'
$src = [IO.File]::ReadAllText($path, [Text.Encoding]::UTF8)
$tokens = $null
$errs = $null
[System.Management.Automation.PSParser]::Tokenize($src, [ref]$errs) | Out-Null
Write-Output ('parse errors: ' + $errs.Count)
if ($errs.Count -gt 0) {
  $errs | Select-Object -First 5 | ForEach-Object {
    Write-Output ('  line ' + $_.Token.StartLine + ' col ' + $_.Token.StartColumn + ': ' + $_.Message)
  }
} else {
  Write-Output 'OK'
}
Write-Output ('has function: ' + $src.Contains('function Send-DshMessage'))
Write-Output ('has case: ' + $src.Contains("'dsh.send'"))
