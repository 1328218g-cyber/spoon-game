# 에디냥 PC (desktop/)

에디냥 웹을 그대로 띄우고, PC에서만 되는 **🎙️ 방송하기**(스푼 방송 고음질 사운드)를 더한 윈도우 프로그램이에요.

- **에디냥 창**: 에디냥 웹 그대로예요 (`https://spoon-game-server.onrender.com`). 로그인, 메뉴, 데이터가 전부 서버에 있어서 모바일이나 다른 PC와 똑같이 이어져요.
- **방송 창**: 스푼 웹이에요. 여기서 방송을 켜면 마이크 대신 에디냥 사운드(리버브·EQ·컴프레서·보이스체인저·배경음악·효과음·PC 소리)가 들어가요.
  - 엔진은 짜잔 에디봇 `broadcast_inject.js`와 같은 코드예요. 바뀐 건 문구(에디봇 → 에디냥)뿐이에요.
- **조절**: 에디냥 창 사이드바 **방송 도구 › 🎙️ 방송하기**에서 해요.
  - 설정은 이 PC와 에디냥 서버(`/broadcast/settings`) 두 곳에 저장돼서, 다른 PC에서도 같은 값을 써요.
- **웹 PC 브라우저**에서 방송하기 메뉴를 열면 설치 안내와 **다운로드 버튼**이 나와요. 모바일에서는 메뉴가 안 보여요.
- 봇(채팅·룰렛 등)은 지금처럼 서버에서 돌아가요. PC판을 꺼도 봇은 그대로예요.

## 새 버전 배포 (자동)

1. `desktop/package.json`의 `"version"`을 올려요 (예: `1.0.0` → `1.0.1`).
2. `render-test`에 푸시해요.
3. GitHub Actions(`.github/workflows/edinyang-pc.yml`)가 윈도우에서 `edinyang-pc-setup.exe`를 만들어서 이 레포 **릴리즈 `v버전`**에 올려요. 5~10분 정도 걸려요.

이렇게 올리면 아래가 자동으로 돼요.
- 웹 다운로드 버튼은 항상 최신 릴리즈를 받아요: `https://github.com/1328218g-cyber/spoon-game/releases/latest/download/edinyang-pc-setup.exe`
- 이미 설치한 사람은 에디냥 PC를 켤 때(그리고 켜둔 동안 3시간마다) 새 버전을 확인해요. 새 버전은 뒤에서 받아두고 "지금 재시작할까요?"라고 물어봐요.
  - 방송 중이면 묻지 않고, 프로그램을 끌 때 자동으로 설치돼요.
- 버전을 안 올리고 푸시하면 이미 배포된 버전이라 빌드를 건너뛰어요. Actions 탭에서 수동으로 돌릴 수도 있어요.

## 직접 빌드 / 개발 실행 (윈도우 PC에서)

```
cd desktop
npm install
npm run build   # dist/edinyang-pc-setup.exe (릴리즈에는 안 올림)
npm start       # 개발 실행 (자동 업데이트는 설치본에서만 동작)
```

테스트 서버에 붙이려면 `EDINYANG_SERVER` 환경변수로 주소를 바꿔요.
예: `set EDINYANG_SERVER=https://테스트주소 && npm start`

## 파일

| 파일 | 하는 일 |
|---|---|
| `main.js` | 창 2개, 방송 창에 엔진 넣기, 에디냥 창 ↔ 엔진 연결(IPC), 음악 파일 서버(127.0.0.1), 녹음 저장(다운로드 › 에디냥 방송녹음), 단축키, 자동 업데이트 |
| `preload-app.js` | 에디냥 웹에 `window.bcast`만 열어줘요 (Node는 노출 안 됨) |
| `preload-spoon.js` | 방송 창에서 엔진이 녹음 조각을 보낼 수 있게 `bcast:rec` 채널 하나만 열어줘요 |
| `broadcast_inject.js` | 사운드 엔진 (짜잔 에디봇과 같은 코드) |
