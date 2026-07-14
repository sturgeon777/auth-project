const http = require('http');

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const FILE_PATH = path.join(__dirname, 'userDatabase.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

let userDatabase = [];
if (fs.existsSync(FILE_PATH)) {
try {
const fileData = fs.readFileSync(FILE_PATH, 'utf-8');
if (fileData.trim()) {
userDatabase = JSON.parse(fileData);
console.log([시스템 초기화] 파일에서 기존 회원 \${userDatabase.length}명의 데이터를 성공적으로 로드했습니다.);
}
} catch (error) {
console.error('[오류] 회원 데이터 파일을 읽는 중 에러가 발생하여 빈 데이터베이스로 시작합니다.', error);
userDatabase = [];
}
}

function hashPasswordServerSide(password, existingSalt = null) {
const salt = existingSalt || crypto.randomBytes(16).toString('hex');
const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
return { salt, hash };
}

const server = http.createServer((req, res) => {
// 1. GET 요청
if (req.method === 'GET') {
// index.html
const targetUrl = req.url === '/' ? 'index.html' : req.url;
const filePath = path.join(PUBLIC_DIR, targetUrl);

    // 상위 경로 탈출 공격 방지 검증
    if (!filePath.startsWith(PUBLIC_DIR)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('403 Forbidden: 접근 권한이 없습니다.');
    }

    // 파일 존재 여부 및 타입 체크
    fs.stat(filePath, (err, stats) => {
        if (err || !stats.isFile()) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            return res.end('404 Not Found: 파일을 찾을 수 없습니다.');
        }

        // 확장자 분석 
        const ext = path.extname(filePath).toLowerCase();
        let contentType = 'text/html; charset=utf-8';
        
        if (ext === '.css') {
            contentType = 'text/css; charset=utf-8';
        } else if (ext === '.js') {
            contentType = 'application/javascript; charset=utf-8';
        } else if (ext === '.png') {
            contentType = 'image/png';
        } else if (ext === '.jpg' || ext === '.jpeg') {
            contentType = 'image/jpeg';
        }

        // 파일 전송
        res.writeHead(200, { 'Content-Type': contentType });
        fs.createReadStream(filePath).pipe(res);
    });
}
// 회원가입
else if (req.method === 'POST' && req.url === '/register') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
        const params = new URLSearchParams(body);
        const username = params.get('username');
        const password = params.get('password');

        if (userDatabase.find(u => u.username === username)) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            return res.end(`
이미 존재하는 아이디입니다.
돌아가기`);
        }

        const secureData = hashPasswordServerSide(password);

        userDatabase.push({
            username: username,
            salt: secureData.salt,
            hash: secureData.hash
        });

        try {
            fs.writeFileSync(FILE_PATH, JSON.stringify(userDatabase, null, 4), 'utf-8');
            
            console.log("\n====== [백엔드 SERVER 파일 저장 완료] ======");
            console.log(`가입 아이디: \${username}`);
            console.log(`생성된 Salt: \${secureData.salt}`);
            console.log(`DB 저장 해시: \${secureData.hash}`);
            console.log("==============================================\n");

            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`
회원가입 성공
돌아가기`);
        } catch (fileError) {
            console.error('[오류] 회원 정보 파일 쓰기 실패:', fileError);
            res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`
서버 내부 오류로 데이터 저장에 실패했습니다.
돌아가기`);
        }
    });
}
// 로그인 검증
else if (req.method === 'POST' && req.url === '/login') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
        const params = new URLSearchParams(body);
        const username = params.get('username');
        const password = params.get('password');

        const user = userDatabase.find(u => u.username === username);

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });

        if (!user) {
            console.log(`\n[로그인 실패] 존재하지 않는 아이디 요청: \${username}\n`);
            return res.end(`
로그인 실패: 아이디가 존재하지 않습니다.
돌아가기`);
        }

        const verifyData = hashPasswordServerSide(password, user.salt);

        console.log("\n====== [백엔드 SERVER 로그인 검증 시도] ======");
        console.log(`조회된 아이디: \${username}`);
        console.log(`불러온 고유 Salt: \${user.salt}`);
        console.log(`DB에 원래 저장되어 있던 해시: \${user.hash}`);
        console.log(\`방금 입력한 비번으로 연산한 해시: \${verifyData.hash}\`);

        if (verifyData.hash === user.hash) {
            console.log("결과: 두 해시값 일치 -> 인증 완료");
            console.log("==============================================\n");
            res.end(`
로그인 성공

어서오세요, \${username}님.
돌아가기`);
        } else {
            console.log("결과: 해시값 불일치 -> 인증 거부");
            console.log("==============================================\n");
            res.end(`
로그인 실패: 비밀번호가 일치하지 않습니다.
돌아가기`);
        }
    });
}

});

server.listen(3000, () => {
console.log("http://localhost:3000 에서 실행 중입니다.");
});