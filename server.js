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

            try {
                fs.writeFileSync(FILE_PATH, JSON.stringify(userDatabase, null, 4), 'utf-8');
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                // 수정된 부분: 회원가입 성공 메시지
                res.end(`
                    <h1>회원가입 완료</h1>
                    <p>회원가입이 성공적으로 완료되었습니다.</p>
                    <a href="/">로그인 페이지로 이동하기</a>
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
                return res.end(`<h3>로그인 실패: 아이디가 존재하지 않습니다.</h3><a href="/">돌아가기</a>`);
            }

            const verifyData = hashPasswordServerSide(password, user.salt);

            if (verifyData.hash === user.hash) {
                // 수정된 부분: 로그인 성공 메시지
                res.end(`
                    <h1>로그인 성공</h1>
                    <p>어서오세요, ${username}님.</p>
                    <a href="/">돌아가기 (메인으로)</a>
                `);
            } else {
                res.end(`<h3>로그인 실패: 비밀번호가 일치하지 않습니다.</h3><a href="/">돌아가기</a>`);
            }
        });
    }
});

server.listen(3000, '0.0.0.0', () => {
    console.log("http://localhost:3000 에서 실행 중입니다.");
});