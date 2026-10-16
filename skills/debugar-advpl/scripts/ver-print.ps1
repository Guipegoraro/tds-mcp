# Abre um print numa janela e apaga o arquivo quando a janela fecha.
# Uso: pwsh -NoProfile -File ver-print.ps1 <arquivo.png> [-FecharEmSeg <n>]
param(
    [Parameter(Mandatory)][string]$Arquivo,
    [int]$FecharEmSeg = 0
)

Add-Type -AssemblyName System.Windows.Forms, System.Drawing

$caminho = (Resolve-Path -LiteralPath $Arquivo).Path
# Le os bytes para a imagem nao prender o arquivo enquanto a janela esta aberta.
$bytes = [System.IO.File]::ReadAllBytes($caminho)
$stream = New-Object System.IO.MemoryStream(, $bytes)
$imagem = [System.Drawing.Image]::FromStream($stream)

$tela = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$form = New-Object System.Windows.Forms.Form
$form.Text = [System.IO.Path]::GetFileName($caminho)
$form.StartPosition = 'CenterScreen'
$form.TopMost = $true
$form.Width = [Math]::Min($imagem.Width + 40, [int]($tela.Width * 0.9))
$form.Height = [Math]::Min($imagem.Height + 60, [int]($tela.Height * 0.9))

$caixa = New-Object System.Windows.Forms.PictureBox
$caixa.Dock = 'Fill'
$caixa.SizeMode = 'Zoom'
$caixa.Image = $imagem
$form.Controls.Add($caixa)
$form.Add_Shown({ $form.TopMost = $false; $form.Activate() })

if ($FecharEmSeg -gt 0) {
    $timer = New-Object System.Windows.Forms.Timer
    $timer.Interval = $FecharEmSeg * 1000
    $timer.Add_Tick({ $form.Close() })
    $timer.Start()
}

try {
    [void]$form.ShowDialog()
}
finally {
    $imagem.Dispose()
    $stream.Dispose()
    $form.Dispose()
    Remove-Item -LiteralPath $caminho -Force -ErrorAction SilentlyContinue
}
