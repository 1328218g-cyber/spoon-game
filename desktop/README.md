# 에디냥 PC (desktop/)

에디냥 웹을 그대로 띄우고, PC에서만 되는 **🎙️ 방송하기**(스푼 방송 고음질 사운드)를 더한 윈도우 프로그램이에요.

- **에디냥 창**: 에디냥 웹 그대로예요 (`https://spoon-game-server.onrender.com`). 로그인, 메뉴, 데이터가 전부 서버에 있어서 모바일이나 다른 PC와 똑같이 이어져요.
- **방송 창**: 스푼 웹이에요. 여기서 방송을 켜면 마이크 대신 에디냥 사운드(리버브·EQ·컴프레서·보이스체인저·배경음악·효과음·PC 소리)가 들어가요.
  - 엔진은 짜잔 에디봇 `broadcast_inject.js`와 같은 코드예요. 바뀐 건 문구(에디봇 → 에디냥)뿐이에요.
- **조절**: 에디냥 창 사이드바 **방송 도구 › 🎙️ 방송하기**에서 해요. 이 메뉴는 PC판에서만 보여요.
  - 설정은 이 PC와 에디냥 서버(`/broadcast/settings`) 두 곳에 저장돼서, 다른 PC에서도 같은 값을 써요.
- 봇(채팅·룰렛 등)은 지금처럼 서버에서 돌아가요. PC판을 꺼도 봇은 그대로예요.

## 설치 파일 만들기 (윈도우 PC에서)

```
cd desktop
npm install
npm run build
```

`dist/edinyang-pc-setup.exe`가 만들어져요.

## 개발/테스트 실행

```
cd desktop
npm install
npm start
```

테스트 서버에 붙이려면 `EDINYANG_SERVER` 환경변수로 주소를 바꿔요.
예: `set EDINYANG_SERVER=https://테스트주소 && npm start`

## 파일

| 파일 | 하는 일 |
|---|---|
| `main.js` | 창 2개, 방송 창에 엔진 넣기, 에디냥 창 ↔ 엔진 연결(IPC), 음악 파일 서버(127.0.0.1), 녹음 저장(다운로드 › 에디냥 방송녹음), 단축키 |
| `preload-app.js` | 에디냥 웹에 `window.bcast`만 열어줘요 (Node는 노출 안 됨) |
| `preload-spoon.js` | 방송 창에서 엔진이 녹음 조각을 보낼 수 있게 `bcast:rec` 채널 하나만 열어줘요 |
| `broadcast_inject.js` | 사운드 엔진 (짜잔 에디봇과 같은 코드) |
