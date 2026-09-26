// 1) https://console.firebase.google.com 에서 프로젝트를 만들고
// 2) 웹 앱(</>) 을 추가하면 아래와 같은 설정값을 보여줍니다.
// 3) 그 값을 그대로 복사해서 아래 객체에 붙여넣으세요.
export const firebaseConfig = {
  apiKey: "AIzaSyCWy5B-hqYtKP8D5id4M9cAJms-vek6L5w",
  authDomain: "mmth-order.firebaseapp.com",
  projectId: "mmth-order",
  storageBucket: "mmth-order.firebasestorage.app",
  messagingSenderId: "186023339141",
  appId: "1:186023339141:web:545b26417457b0d41835ec",
};

// Firebase 콘솔 > 프로젝트 설정(⚙️) > Cloud Messaging 탭 > "웹 푸시 인증서"에서
// "키 쌍 생성"을 누르면 나오는 값을 여기에 붙여넣으세요. (Blaze 요금제 없이도 발급 가능)
export const VAPID_KEY = "BLkvsUFi8JhutD2_iWojpqcPV7VCBXnUP9O15EnJhv3FluugunXRf-e61Q9nvPclzha62Da8skS66dGPI3zL3Rw";

// 매장 이름 (대시보드/공유 텍스트 상단에 표시됩니다)
export const STORE_NAME = "매머드 익스프레스 커피";

// 사장님 PIN은 여기 하드코딩하지 않습니다. 앱에서 최초로 "사장님"을 등록하는 사람이
// 직접 PIN을 만들고, 그 값이 Firestore(config/ownerPin)에 저장됩니다.

// 사장님 화면에서 "발주하기" 바로가기로 보여줄 사이트 목록.
// 자주 쓰는 쇼핑몰/발주처를 자유롭게 추가·삭제하세요.
export const QUICK_ORDER_LINKS = [
  { label: "Jette(발주)", url: "https://ebiz.jette.co.kr/Home/LogOn?ReturnUrl=%2f" },
  { label: "❤️내 사랑 쿠팡❤️", url: "https://www.coupang.com" },
];
