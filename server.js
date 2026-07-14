const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const FILE_PATH = path.join(__dirname, 'userDatabase.json');

let userDatabase = [];
if (fs.existsSync(FILE_PATH)) {
    try {
        const fileData = fs.readFileSync(FILE_PATH, 'utf-8');
        if (fileData.trim()) {
            userDatabase = JSON.parse(fileData);
            console.log(`[시스템 초기화] 파일에서 기존 회원 ${userDatabase.length}명의 데이터를 성공적으로 로드했습니다.`);
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
    if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>로그인/회원가입</title>
                <style>
                    body { font-family: sans-serif; max-width: 600px; margin: 30px auto; padding: 20px; border: 1px solid #ccc; border-radius: 10px; }
                    .form-box { margin-bottom: 30px; padding: 15px; border: 1px solid #ddd; border-radius: 6px; background-color: #f9f9f9; }
                    input, button { width: 100%; padding: 10px; margin: 8px 0; box-sizing: border-box; }
                    button { color: white; border: none; font-weight: bold; cursor: pointer; }
                    .btn-reg { background-color: #27ae60; }
                    .btn-login { background-color: #2980b9; }
                </style>
            </head>
            <body>
                <h2>(가입/로그인)</h2>
                <div class="form-box">
                    <h3>1. 회원가입</h3>
                    <form action="/register" method="POST">
                        <input type="text" name="username" placeholder="아이디 입력" required>
                        <input type="password" name="password" placeholder="비밀번호 입력" required>
                        <button type="submit" class="btn-reg">회원가입</button>
                    </form>
                </div>
                <div class="form-box">
                    <h3>2. 로그인</h3>
                    <form action="/login" method="POST">
                        <input type="text" name="username" placeholder="아이디 입력" required>
                        <input type="password" name="password" placeholder="비밀번호 입력" required>
                        <button type="submit" class="btn-login">로그인</button>
                    </form>
                </div>
            </body>
            </html>
        `);
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
                return res.end(`<h3>이미 존재하는 아이디입니다.</h3><a href="/">돌아가기</a>`);
            }

            const secureData = hashPasswordServerSide(password);
            userDatabase.push({
                username: username,
                salt: secureData.salt,
                hash: secureData.hash
            });

            console.log("\n====== [백엔드 SERVER 신규 회원가입 처리] ======");
            console.log(`요청 아이디: ${username}`);
            console.log(`생성된 고유 Salt: ${secureData.salt}`);
            console.log(`DB에 저장할 최종 해시: ${secureData.hash}`);
            console.log("결과: 사용자 정보 객체 생성 및 배열 삽입 완료");
            console.log("==============================================\n");

            try {
                fs.writeFileSync(FILE_PATH, JSON.stringify(userDatabase, null, 4), 'utf-8');
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(`
                    <h1>회원가입 완료</h1>
                    <p>회원가입이 성공적으로 완료되었습니다.</p>
                    <a href="/">돌아가기</a>
                `);
            } catch (fileError) {
                res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(`<h3>서버 내부 오류로 데이터 저장에 실패했습니다.</h3><a href="/">돌아가기</a>`);
            }
        });
    }
    // 로그인
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
                console.log(`\n[로그인 실패] 존재하지 않는 아이디 요청: ${username}\n`);
                return res.end(`<h3>로그인 실패: 아이디가 존재하지 않습니다.</h3><a href="/">돌아가기</a>`);
            }

            const verifyData = hashPasswordServerSide(password, user.salt);

            console.log("\n====== [백엔드 SERVER 로그인 검증 시도] ======");
            console.log(`조회된 아이디: ${username}`);
            console.log(`불러온 고유 Salt: ${user.salt}`);
            console.log(`DB에 원래 저장되어 있던 해시: ${user.hash}`);
            console.log(`방금 입력한 비번으로 연산한 해시: ${verifyData.hash}`);

            if (verifyData.hash === user.hash) {
                console.log("결과: 두 해시값 일치 -> 인증 완료");
                console.log("==============================================\n");
                res.end(`
                    <h1>로그인 성공</h1>
                    <p>어서오세요, ${username}님.</p>
                    <a href="/">돌아가기</a>
                `);
            } else {
                console.log("결과: 해시값 불일치 -> 인증 거부");
                console.log("==============================================\n");
                res.end(`<h3>로그인 실패: 비밀번호가 일치하지 않습니다.</h3><a href="/">돌아가기</a>`);
            }
        });
    }
    // 404 Not Found
    else {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('페이지를 찾을 수 없습니다.');
    }
});

server.listen(3000, '0.0.0.0', () => {
});