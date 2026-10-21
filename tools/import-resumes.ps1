param(
  [string[]]$Folders = @(
    "$env:USERPROFILE\Downloads",
    "$env:USERPROFILE\Documents",
    "$env:USERPROFILE\Desktop"
  ),
  [switch]$Upload,
  [switch]$ConfirmDataRights,
  [string]$ApiUrl = "https://imena.kz/api/resume",
  [string]$ReportPath = ".\imena-resume-import-report.csv"
)

$ErrorActionPreference = "Stop"

if ($Upload -and -not $ConfirmDataRights) {
  throw "Для загрузки добавьте параметр -ConfirmDataRights, подтверждая право на обработку и перенос этих резюме в Bitrix24."
}

$existingFolders = $Folders |
  Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Container) } |
  Select-Object -Unique

if (-not $existingFolders) {
  throw "Не найдены выбранные папки. Укажите их через -Folders."
}

$files = foreach ($folder in $existingFolders) {
  Get-ChildItem -LiteralPath $folder -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object {
      $_.Extension.ToLowerInvariant() -in @(".pdf", ".docx") -and
      $_.Length -le 4MB -and
      $_.FullName -notmatch "\\(AppData|Windows|Program Files|ProgramData|node_modules|\.git)\\"
    }
}
$files = $files | Sort-Object FullName -Unique

Write-Host "Найдено файлов PDF/DOCX: $($files.Count)"
if (-not $files.Count) {
  exit 0
}

$results = [System.Collections.Generic.List[object]]::new()
$index = 0

foreach ($file in $files) {
  $index++
  $mode = if ($Upload) { "загрузка" } else { "анализ" }
  Write-Progress -Activity "Имена — импорт резюме" -Status "$mode: $($file.Name)" -PercentComplete (($index / $files.Count) * 100)

  $curlArgs = @(
    "-sS",
    "--max-time", "120",
    "-X", "POST",
    $ApiUrl,
    "-F", "consent=yes",
    "-F", "import_mode=yes",
    "-F", "source=импорт с компьютера Жанары",
    "-F", "resume=@$($file.FullName)"
  )
  if (-not $Upload) {
    $curlArgs += @("-F", "dry_run=yes")
  }

  try {
    $raw = & curl.exe @curlArgs
    if ($LASTEXITCODE -ne 0) {
      throw "curl завершился с кодом $LASTEXITCODE"
    }
    $response = $raw | ConvertFrom-Json
    $data = $response.data

    $status = if ($response.ok) {
      if ($Upload) { $response.action } else { "проанализировано" }
    } else {
      "ошибка"
    }

    $results.Add([pscustomobject]@{
      File = $file.FullName
      Status = $status
      ContactId = $response.contactId
      FirstName = $data.first_name
      LastName = $data.last_name
      MiddleName = $data.middle_name
      Position = $data.position
      Company = $data.company
      City = $data.city
      Education = $data.education
      Phone = $data.phone
      Email = $data.email
      MissingFields = ($response.missingFields -join ", ")
      Message = $response.message
    })
  }
  catch {
    $results.Add([pscustomobject]@{
      File = $file.FullName
      Status = "ошибка"
      ContactId = ""
      FirstName = ""
      LastName = ""
      MiddleName = ""
      Position = ""
      Company = ""
      City = ""
      Education = ""
      Phone = ""
      Email = ""
      MissingFields = ""
      Message = $_.Exception.Message
    })
  }
}

$results | Export-Csv -LiteralPath $ReportPath -NoTypeInformation -Encoding UTF8
Write-Progress -Activity "Имена — импорт резюме" -Completed

$okCount = @($results | Where-Object { $_.Status -ne "ошибка" }).Count
$errorCount = @($results | Where-Object { $_.Status -eq "ошибка" }).Count

Write-Host ""
Write-Host "Готово."
Write-Host "Обработано: $okCount"
Write-Host "Ошибок: $errorCount"
Write-Host "Отчёт: $((Resolve-Path -LiteralPath $ReportPath).Path)"
if (-not $Upload) {
  Write-Host ""
  Write-Host "Это был безопасный анализ без записи в Bitrix24."
  Write-Host "Для загрузки запустите повторно с параметрами -Upload -ConfirmDataRights."
}
