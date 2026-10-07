<#
  dsh-feishu-channel 安装脚本

  用法：
      .\install.ps1 -Profile <你的 profile 名>

  例如：
      .\install.ps1 -Profile web

  它做三件事：
    1. 若源码路径含空格，建一个无空格的 junction（pnpm 的 file:/link: 规格
       会被空格截断，这是必做的绕行）
    2. 用 dsh plugin add 装进 profile —— 这会自动把包名加进 dsh.profile.bundles
    3. 打印还需要你手动粘贴的配置模板

  装完之后：编辑 profile 的 cordis.patch.yml（脚本会打印路径），
  把 cordis.patch.example.yml 的内容填好粘进去，然后重启该 profile。
#>
param(
    [Parameter(Mandatory = $true)][string]$Profile,
    [string]$SourceDir = $PSScriptRoot,
    [string]$LinkDir = 'C:\dsh-local-plugins\feishu-channel'
)

$ErrorActionPreference = 'Stop'

Write-Host "== dsh-feishu-channel 安装 ==" -ForegroundColor Cyan
Write-Host "源码目录 : $SourceDir"
Write-Host "目标 profile: $Profile"
Write-Host ""

# ---- 1. 路径含空格 → 建 junction -------------------------------------------
if ($SourceDir -match ' ') {
    $parent = Split-Path $LinkDir -Parent
    if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    if (Test-Path $LinkDir) {
        # 已存在则先看它指向哪；不是我们要的目标才重建
        $cur = (Get-Item $LinkDir -Force).Target
        if ($cur -and ($cur -join '') -ne $SourceDir) {
            Remove-Item $LinkDir -Force -Recurse
        }
    }
    if (-not (Test-Path $LinkDir)) {
        New-Item -ItemType Junction -Path $LinkDir -Target $SourceDir | Out-Null
        Write-Host "[1/3] 已建 junction: $LinkDir -> $SourceDir" -ForegroundColor Green
    } else {
        Write-Host "[1/3] junction 已存在，复用" -ForegroundColor Green
    }
    $spec = "link:$LinkDir"
} else {
    Write-Host "[1/3] 路径无空格，无需 junction" -ForegroundColor Green
    $spec = "link:$SourceDir"
}

# ---- 2. 装进 profile --------------------------------------------------------
Write-Host "[2/3] dsh plugin add $spec" -ForegroundColor Green
& dsh plugin --profile $Profile add $spec
if ($LASTEXITCODE -ne 0) { throw "dsh plugin add 失败（exit $LASTEXITCODE）" }

# ---- 3. 打印待粘贴的配置 ----------------------------------------------------
$patchPath = Join-Path $env:USERPROFILE ".dsh\profiles\$Profile\cordis.patch.yml"
Write-Host ""
Write-Host "[3/3] 还需手动配置：" -ForegroundColor Yellow
Write-Host "      编辑 $patchPath" -ForegroundColor Yellow
Write-Host "      把 cordis.patch.example.yml 的内容填好后粘进去" -ForegroundColor Yellow
Write-Host ""
Write-Host "----- cordis.patch.example.yml -----" -ForegroundColor DarkGray
Get-Content (Join-Path $SourceDir 'cordis.patch.example.yml') -ErrorAction SilentlyContinue |
    ForEach-Object { Write-Host $_ -ForegroundColor DarkGray }
Write-Host "------------------------------------" -ForegroundColor DarkGray
Write-Host ""
Write-Host "完成后重启该 profile 即可。" -ForegroundColor Cyan
