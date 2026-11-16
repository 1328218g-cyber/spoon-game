// 💰 요금제 변경 안내 팝업 (2027년 1월부터 초이스 상관없이 월 1만원 · 2026년 12월 결제부터 적용)
//  · 접속할 때마다 떠요 · "오늘 하루 보지 않기" 체크하고 닫으면 그날은 안 떠요 (이 기기 · 이 브라우저만)
(function () {
  var IMG = '/notice/price-2027.png';
  var KEY = 'edi_price2027_hide';
  var d = new Date(), today = d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  try { if (window.top !== window) return; } catch (e) { return; } // (iframe 안에선 안 띄워요)
  if (/[?&]pcpop=1/.test(location.search)) return; // (폰 채팅 팝업창 같은 작은 창에선 안 띄워요)
  try { if (localStorage.getItem(KEY) === today) return; } catch (e) {}
  function show() {
    if (document.getElementById('ediPriceNotice')) return;
    var o = document.createElement('div');
    o.id = 'ediPriceNotice';
    o.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:rgba(10,8,6,.72);display:flex;align-items:center;justify-content:center;padding:12px;box-sizing:border-box';
    o.innerHTML =
      '<div style="position:relative;width:min(520px,100%);max-height:96vh;overflow-y:auto;background:#fff;border-radius:18px;padding:10px;box-sizing:border-box;box-shadow:0 20px 50px rgba(0,0,0,.45)">' +
        '<button type="button" data-x aria-label="닫기" style="position:absolute;top:16px;right:16px;width:34px;height:34px;border:0;border-radius:50%;background:rgba(0,0,0,.5);color:#fff;font-size:18px;line-height:34px;cursor:pointer;padding:0">✕</button>' +
        '<img src="' + IMG + '" alt="요금제 변경 안내: 2027년 1월부터 초이스 상관없이 모두 월 10,000원, 2026년 12월 결제부터 적용" style="width:100%;display:block;border-radius:12px">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 4px 2px;font-family:inherit">' +
          '<label style="display:flex;align-items:center;gap:7px;font-size:13px;color:#6b5a4c;cursor:pointer;user-select:none"><input type="checkbox" data-today style="width:16px;height:16px;margin:0"> 오늘 하루 보지 않기</label>' +
          '<button type="button" data-x style="border:0;border-radius:10px;background:#ff7a1a;color:#fff;font-weight:700;font-size:14px;padding:9px 22px;cursor:pointer">확인</button>' +
        '</div>' +
      '</div>';
    function close() {
      var ck = o.querySelector('[data-today]');
      if (ck && ck.checked) { try { localStorage.setItem(KEY, today); } catch (e) {} }
      o.remove();
    }
    o.addEventListener('click', function (e) { if (e.target === o || (e.target.closest && e.target.closest('[data-x]'))) close(); });
    document.body.appendChild(o);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show); else show();
})();
