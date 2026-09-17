# 사용법: deploy "커밋 메시지"
# 변경사항이 있으면 커밋하고, GitHub에 push한 뒤 서버에서 pull + 재시작까지 한 번에 한다.
# 서버 주소와 키는 ~/.ssh/config 의 'space' 항목에 있다 (공개 저장소에 IP를 올리지 않기 위함).
param([string]$Message)

Set-Location $PSScriptRoot

$branch = git rev-parse --abbrev-ref HEAD
if ($branch -ne 'main') {
  Write-Host "main 브랜치에서만 배포할 수 있습니다. (현재: $branch)" -ForegroundColor Red
  exit 1
}

if (git status --porcelain) {
  if (-not $Message) {
    Write-Host '커밋하지 않은 변경사항이 있습니다. 메시지를 붙여서 실행하세요: deploy "무엇을 바꿨는지"' -ForegroundColor Yellow
    exit 1
  }
  git add -A
  git commit -m $Message
  if ($LASTEXITCODE -ne 0) { exit 1 }
}

Write-Host '>> GitHub에 push' -ForegroundColor Cyan
git push origin main
if ($LASTEXITCODE -ne 0) { exit 1 }

# PowerShell 5.1은 외부 명령 인자 안의 큰따옴표를 망가뜨리므로 원격 명령에는 작은따옴표/따옴표 없는 문법만 쓴다
$remote = @(
  'export NVM_DIR=$HOME/.nvm',
  '. $NVM_DIR/nvm.sh',
  'set -e',
  'cd ~/auth-project',
  'mkdir -p backups',
  'cp database.json backups/predeploy_$(date +%Y%m%d_%H%M%S).json',
  'before=$(git rev-parse HEAD)',
  'git pull --ff-only',
  'if ! git diff --quiet $before HEAD -- package.json package-lock.json; then npm install --omit=dev --no-audit --no-fund; fi',
  'pm2 restart auth-server --update-env',
  'sleep 2',
  'curl -fsS http://127.0.0.1:3000/api/stats',
  'echo'
) -join '; '

Write-Host '>> 서버에서 pull 후 재시작' -ForegroundColor Cyan
ssh space $remote
if ($LASTEXITCODE -ne 0) {
  Write-Host '서버 배포 중 오류가 났습니다. 위 로그를 확인하세요. (서버 로그: ssh space 후 pm2 logs auth-server)' -ForegroundColor Red
  exit 1
}

Write-Host '배포 완료!' -ForegroundColor Green
