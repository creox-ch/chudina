// Авто-год: элементы <span class="js-year"> получают текущий год (работает на проде).
(function(){
  function setYear(){try{var y=new Date().getFullYear();var els=document.querySelectorAll('.js-year');for(var i=0;i<els.length;i++)els[i].textContent=y;}catch(e){}}
  if(document.readyState!=='loading')setYear();else document.addEventListener('DOMContentLoaded',setYear);
})();

// Локальная навигация: сайт использует clean-URL ссылки (/put, /igry),
// которые не открываются как локальные файлы. Здесь перехватываем клики
// и переписываем их на соответствующий .html в этой же папке.
(function(){
  // Активно ТОЛЬКО при локальном просмотре (file://). На проде clean-URL
  // работают нативно (Vercel cleanUrls) — переписывать /put в put.html не нужно
  // и вредно (лишний редирект). Поэтому на https/http выходим сразу.
  if(location.protocol!=='file:')return;
  var pages=['index','put','proekty','igry','cashflow','team','partnerstvo','kontakty','impressum','agb','datenschutz'];
  function toFile(h){
    if(!h||/^(https?:|mailto:|tel:|#)/.test(h))return null;
    var base=h.split('#')[0].split('?')[0].replace(/^\.\//,'').replace(/^\//,'').replace(/\/$/,'');
    if(base==='')base='index';
    base=base.replace(/\.html$/,'');
    return pages.indexOf(base)>=0?base+'.html':null;
  }
  document.addEventListener('click',function(e){
    var a=e.target.closest&&e.target.closest('a[href]');if(!a)return;
    var file=toFile(a.getAttribute('href'));
    if(file){
      var hash=(a.getAttribute('href').split('#')[1]||'');
      e.preventDefault();
      location.href=file+(hash?'#'+hash:'');
    }
  },true);
  // запоминаем текущую страницу для хаба «Весь сайт»
  try{var cur=(location.pathname.split('/').pop()||'index.html');if(!/\.html$/.test(cur))cur+='.html';localStorage.setItem('site-hub-page',cur);}catch(e){}
})();
