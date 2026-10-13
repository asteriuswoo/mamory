# 트러블슈팅 기록

## 중요 — 최종 결론 (읽고 시작할 것)
아래 2번(Auth iframe 회피)·3번(롱폴링 강제) 수정은 밤새 여러 번 바꿔보면서
결과가 그때그때 달라(됐다 안 됐다) 오히려 더 불안정해진 것으로 보여 **전부
되돌렸다**. 최종적으로 `public/js/firebase-init.js`는 Firestore/Auth 둘 다
평범한 기본 초기화(`getFirestore(app)`, `getAuth(app)`)로 복귀한 상태다.

**진짜 핵심 원인은 따로 있었다 (5번 참고)**: `enableIndexedDbPersistence()`가
localStorage에 남기는 `firestore_zombie_firestore/...` 흔적이, 홈화면
standalone 앱을 완전 종료(강제 종료라 정리할 틈이 없음)했다 재실행하는 걸
반복하면서 계속 쌓였고, 그게 다음 실행의 "대표 탭 선정"을 막아 Firestore
요청이 네트워크 시도조차 없이 영원히 멈추는 원인이었다. 웹 인스펙터
저장공간 탭에서 직접 눈으로 확인함(zombie 키 3개 발견). 이 기능 자체를
꺼서 해결 시도함 — 1번(Notification)과 5번(zombie 흔적) 둘 다 실제
증거로 뒷받침되는 가장 유력한 원인들이다.

## 2026-10-12 밤 — 모바일 사파리에서 데이터 안 뜨고 버튼 반응 없음

### 증상
- 진우님 아이폰에서만(다른 직원은 정상) 앱이 "틀만 있고" 자재 목록/시재/공유/노래 등 데이터가 전혀 안 뜸
- 버튼을 눌러도 아무 반응 없음
- 로그인 시 "확인 중..."에서 멈추고 PIN 입력 화면으로 안 넘어감
- 캐시 삭제, 앱 재설치(사파리/크롬), 와이파이·셀룰러 전환, 비행기모드, VPN·DNS·Private Relay 확인 등 다 시도해도 재현됨
- 맥 사파리 웹 인스펙터로 원격 디버깅해서 실제 콘솔/네트워크 로그를 보고서야 원인 특정

### 원인 (3가지가 겹쳐서 발생)

**1. `Notification` 전역 객체 미체크로 인한 크래시 (가장 치명적)**
- `public/js/staff.js:1457`, `public/js/app-shell.js:161`에 `if (Notification.permission === "granted") ...`처럼 `Notification` 존재 여부를 체크 안 하고 바로 참조
- iOS 사파리 **일반 탭**(홈화면에 설치 안 한 상태)에서는 `Notification`/Push API 자체가 전역에 존재하지 않음 (iOS 16.4+ 홈화면 설치 앱에서만 지원)
- `main()` 함수 안에서 이 줄이 `ReferenceError: Can't find variable: Notification`을 던지면서, 그 뒤에 이어지던 모든 초기화 코드(자재 목록 구독, 버튼 이벤트 연결 등)가 전부 실행되지 않음
- **수정**: `if ("Notification" in window && Notification.permission === "granted") ...`로 존재 여부 가드 추가

**2. Firebase Auth의 숨은 iframe이 멈춤**
- `getAuth(app)`은 구글 로그인 같은 팝업/리다이렉트 방식을 대비해서 `authDomain`(`*.firebaseapp.com`)에서 보이지 않는 iframe을 미리 로드함
- 이 앱은 전화번호+PIN 로그인만 쓰고 팝업/리다이렉트 로그인을 전혀 안 쓰는데도 이 iframe이 기본으로 로드됨
- 이 iframe이 `mamory.web.app` 안에 "제3자 iframe"으로 끼워지는 형태라, 사파리의 추적 방지(ITP) 정책에 걸려 응답 없이 멈추는 경우가 있었음(직접 `mmth-order.firebaseapp.com`에 새 탭으로 들어가면 정상 로드되는데, iframe으로 끼워 넣으면 멈춤 — 임베드 컨텍스트 특이 문제로 추정)
- **수정**: `public/js/firebase-init.js`에서 `getAuth(app)` 대신 `initializeAuth(app, { persistence: [...], popupRedirectResolver 생략 })` 사용 — 팝업/리다이렉트 전용 초기화(iframe 로딩)를 아예 건너뜀

**3. Firestore 기본 스트리밍 연결이 간헐적으로 끊김**
- 콘솔에 `Fetch API cannot load .../Listen/channel?... due to access control checks` 에러가 반복적으로 뜸
- Firestore의 기본 연결 방식(WebChannel, QUIC/HTTP3 가능)이 특정 네트워크 환경과 잘 안 맞는 것으로 추정
- **수정**: `initializeFirestore(app, { experimentalForceLongPolling: true })`로 강제 롱폴링 전환 (처음엔 `experimentalAutoDetectLongPolling`을 시도했으나 "감지" 단계 자체가 멈추는 것으로 보여 강제 방식으로 변경)

### 결과 (1차)
- 위 3가지를 모두 고친 뒤 **사파리 일반 탭**에서는 완전히 정상 동작 확인(콘솔 에러 없음, 데이터 정상 로드, 버튼 정상 동작)
- **홈화면에 설치한 독립 실행(standalone) 앱**은 사파리 데이터 완전 삭제 후 재설치하면 처음엔 정상 동작하지만, **앱을 종료했다가 다시 켜면(백그라운드 복귀) 다시 데이터가 안 뜨는 패턴**으로 재현됨

### 4번째 원인 — standalone 앱의 백그라운드 복귀 감지 실패
- `public/js/firebase-init.js`에 이미 "오래 숨어있다 돌아오면 Firestore 연결을 강제로 껐다 켜는" 로직이 있었는데, 이게 `visibilitychange` 이벤트 하나에만 의존했음
- 홈화면에 설치한 standalone 앱은 **백그라운드로 갈 때 `visibilitychange`가 안 오는 경우가 있어서**, "얼마나 오래 숨어있었는지" 자체를 추적 못해 재연결 로직이 전혀 발동 안 됨
- **수정**: 숨김 시작 시점을 이벤트가 아니라 5초마다 찍는 하트비트(`setInterval`)로 추적하도록 변경 — 탭/앱이 중단되면 `setInterval`도 같이 멈추므로, 다시 돌아왔을 때(`visibilitychange`/`pageshow`/`focus` 중 뭐가 됐든 먼저 오는 신호로) 마지막 하트비트와의 간격을 재면 정확한 정지 시간이 나옴. 세 이벤트 모두에 리스너를 걸어 standalone 모드에서도 최소 하나는 걸리도록 함

### 그 외에 코드와 무관한 것
- 콘솔에 뜬 `viewportDominantIFrameElement` 관련 에러는 저희 코드가 아니라 구글 자체 라이브러리(gapi) 내부 에러로, 기능에 영향 없어 보임(무시해도 됨)

### 2·3·4번은 전부 되돌림, 진짜 원인은 5번
2·3번 적용 후에도 "standalone 앱 재실행하면 안 됨" 패턴이 그대로 재현됐고,
2·3·4번을 손대는 동안 오히려 멀쩡하던 **사파리 일반 탭까지 같이 안 되는**
일까지 생겨서 — 전부 원래 기본 설정(`getFirestore(app)`, `getAuth(app)`)
으로 되돌렸다. 되돌리자 사파리 탭은 다시 안정적으로 잘 됐다. 즉 2·3번은
애초에 원인이 아니었을 가능성이 높다.

**5. (✅ 확인된 진짜 원인) `enableIndexedDbPersistence()`의 "zombie 탭" 흔적이 안 지워짐**
- "몇 주간 멀쩡했는데 오늘 밤부터 갑자기 이런다"는 진우님 지적이 결정적 단서였음 — iOS 고질 문제가 아니라 오늘 밤 생긴 무언가라는 뜻
- 웹 인스펙터 저장공간(Storage) 탭에서 로컬 저장소를 직접 열어보니, `firestore_zombie_firestore/[DEFAULT]/mmth-order/_...` 형태의 키가 **3개**나 쌓여있는 걸 눈으로 확인
- 이건 Firestore의 오프라인 캐시(`enableIndexedDbPersistence`)가 "여러 탭/인스턴스 중 누가 대표(primary)인지" 조율하려고 localStorage에 남기는 흔적 — 정상적으로 탭을 닫으면 정리되는데, 홈화면 standalone 앱을 **완전 종료(강제 종료)하면 정리할 JS가 돌 틈도 없이 꺼져버려서** 흔적이 안 지워짐
- 오늘 밤 재설치/재실행을 평소보다 훨씬 많이 반복하면서 이 흔적이 빠르게 쌓였고, 쌓인 흔적이 다음 실행의 "대표 탭 선정"을 막으면서 Firestore 요청이 네트워크 시도조차 없이 영원히 멈춘 것으로 추정
- **수정**: `enableIndexedDbPersistence(db)` 호출 자체를 제거 — 이 앱은 상시 연결 상태로 쓰는 용도라 오프라인 캐시가 꼭 필요하지 않음. "흔적이 쌓인다"는 원인 자체를 없앰
- 이미 쌓여있던 흔적은 기능을 꺼도 자동으로 안 지워지므로, 테스트 전에 웹 인스펙터 저장공간 탭에서 직접 지우거나 "방문 기록 및 웹 사이트 데이터 지우기"로 한 번은 완전히 비워줘야 함
- **결과: 흔적을 지우고 재설치한 뒤로는 홈화면 standalone 앱을 완전 종료 후 재실행해도 정상 동작 확인됨 (2026-10-12 밤 당일 확인)**

### 그래도 안 되면 다음에 시도해볼 것
- standalone 모드를 Web Inspector로 직접 띄워서(맥 개발자 메뉴에 "Web — mamory.web.app"으로 뜸, "Safari"가 아니라 "Web"이라는 라벨이 붙는 게 특징) 네트워크 탭에서 정확히 어느 시점에 요청이 전혀 안 나가는지 확인
- Service Worker가 fetch를 가로채고 있는 건 아닌지(sw.js는 origin이 다르면 pass-through 하도록 돼있지만 재확인 필요)
- 임시 조치로는 홈화면 아이콘 대신 사파리 북마크(일반 탭)로 사용 가능

### 디버깅에 유용했던 방법
- 맥에 아이폰을 케이블(또는 네트워크)로 연결 → 사파리 설정 → 고급 → "메뉴 막대에 개발자용 메뉴 보기" 켜기 → 아이폰 쪽 설정 → Safari → 고급 → 웹 검사기 켜기 → 맥 사파리 개발자 메뉴에서 기기 선택 → 실시간 콘솔/네트워크 확인
- 콘솔에 직접 진단 스크립트를 붙여넣어 `getDocs()`/`readyAuth` 등을 개별적으로 테스트해서 "어디서 멈추는지" 좁혀나감
