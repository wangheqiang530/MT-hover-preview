// ==UserScript==
// @name         M-Team 种子缩略图悬停预览
// @namespace    https://github.com/wangheqiang530/MT-hover-preview
// @version      1.6.1
// @description  鼠标悬停在 M-Team 种子缩略图上自动弹出大图（最多约占屏幕 90%，且避开缩略图不挡鼠标），移开自动收起，不用再点击
// @author       wangheqiang530
// @homepageURL  https://github.com/wangheqiang530/MT-hover-preview
// @supportURL   https://github.com/wangheqiang530/MT-hover-preview/issues
// @license      MIT
// @match        *://*.m-team.cc/*
// @match        *://m-team.cc/*
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  "use strict";

  /**
   * M-Team 种子列表每行最左侧的缩略图是 antd 的 Image 组件：
   *   <div class="ant-image">
   *     <img class="ant-image-img torrent-list__thumbnail" src="...">
   *     <div class="ant-image-cover ant-image-cover-center">…</div>
   *   </div>
   * 点击它会弹出 antd 的原生预览（锁滚动、必须点遮罩才关得掉）。
   *
   * 本脚本改成：鼠标悬停在缩略图上直接弹一张大图（最多约占屏幕 90%），移开就自动消失。
   * 大图会避开缩略图所在的矩形，优先贴在缩略图右侧，右侧放不下再依次尝试左侧/下方/上方，
   * 所以鼠标停着的那一块永远不会被盖住。
   *
   * 几个关键点（都是实测踩出来的）：
   * 1. antd 在 img 上面盖了一层 .ant-image-cover 遮罩，鼠标真正停在遮罩上，
   *    所以命中判断要从 .ant-image 容器反查子 img，不能只 closest("img")。
   * 2. 预览层必须 pointer-events: none：它一旦接管鼠标事件，马上就会触发 mouseout，
   *    形成「打开 → 移开 → 关闭 → 打开」的自激闪烁。
   * 3. 站点真正的滚动容器是 .ant-layout（overflow-y: scroll）而不是 document，
   *    滚动监听必须挂捕获阶段才收得到。滚动会让浏览器重新计算 hover 目标，
   *    从而补发 mouseover，所以滚动后还要短暂忽略悬停，否则大图会在滚动时闪。
   * 4. 缩略图的 src 指向的就是 douban 原图（不是 52×70 的缩略尺寸），放大后依然清晰；
   *    只有原图本身确实很小时才限制放大倍数，免得糊成色块。
   * 5. 缩略图 URL 带签名且约 30 分钟过期，所以直接复用页面里那张图，不自己拼 URL、不缓存。
   */

  const THUMB_SELECTOR = "img.torrent-list__thumbnail";
  const WRAP_CLASS = "mteam-hover-thumb";
  const Z_INDEX = "2147483000";

  const SHOW_DELAY = 120; // 悬停多久后弹出，避免快速划过时闪
  const HIDE_DELAY = 140; // 鼠标移开后多久收起，留一点抖动缓冲
  const FADE_MS = 150; // 淡入淡出时长，要和 CSS 里的 transition 一致
  const SCROLL_MUTE = 300; // 滚动时抑制悬停多久，避免滚动过程中大图乱闪
  const MAX_UPSCALE = 3; // 原图比可用区域还小时，最多放大几倍
  const FLAT_RATIO = 0.62; // 拿不到原图尺寸时先用这个比例占位，避免跳变
  const EDGE = 12; // 大图与视口边缘至少留多少
  const SAFE_GAP = 16; // 大图与缩略图之间至少留多少，保证不压住鼠标
  const MIN_REGION = 220; // 候选区域至少这么大才优先考虑，否则退而取最大的一块

  const CSS = `
    .${WRAP_CLASS} {
      position: fixed;
      left: 0;
      top: 0;
      width: 0;
      height: 0;
      z-index: ${Z_INDEX};
      display: none;
      margin: 0;
      padding: 0;
      border: 0;
      pointer-events: none;
      opacity: 0;
      transition: opacity ${FADE_MS}ms ease;
    }
    .${WRAP_CLASS}.${WRAP_CLASS}--shown {
      display: block;
    }
    .${WRAP_CLASS}.${WRAP_CLASS}--visible {
      opacity: 1;
    }
    .${WRAP_CLASS} > img {
      display: block;
      width: 100%;
      height: 100%;
      border-radius: 10px;
      background: #101010;
      box-shadow: 0 30px 90px rgba(0, 0, 0, 0.7), 0 0 0 1px rgba(255, 255, 255, 0.14);
      object-fit: contain;
    }
  `;

  let card = null;
  let cardImg = null;
  let activeThumb = null;
  let showTimer = 0;
  let hideTimer = 0;
  let fadeTimer = 0;
  let mutedUntil = 0;

  function ensureCard() {
    if (card && card.isConnected) return card;
    card = document.createElement("div");
    card.className = WRAP_CLASS;
    card.setAttribute("aria-hidden", "true");
    cardImg = document.createElement("img");
    cardImg.alt = "";
    cardImg.decoding = "async";
    card.appendChild(cardImg);
    (document.body || document.documentElement).appendChild(card);
    return card;
  }

  // 站点自己点出来的 antd 全屏预览还开着的时候不要再叠一层，
  // 否则用户点开原生预览后，鼠标一动就被我们的卡片糊上去。
  function nativePreviewOpen() {
    return !!document.querySelector(".ant-image-preview, .ant-image-preview-root");
  }

  function thumbImageSrc(thumb) {
    const src = thumb.currentSrc || thumb.getAttribute("src") || "";
    if (!src) return "";
    // 站点没有封面时用 emptyImg.svg 占位（父级还会加 .ant-image-error），这种没必要放大
    if (src.indexOf("emptyImg") !== -1) return "";
    const box = thumb.closest(".ant-image");
    if (box && box.classList.contains("ant-image-error")) return "";
    return src;
  }

  function isCardVisible() {
    return !!(card && card.classList.contains(WRAP_CLASS + "--visible"));
  }

  // 挑一块「不压住鼠标」的可用区域：以缩略图矩形为基准，把视口切成右/左/下/上四块。
  // 只在四块里选，所以永远覆盖不到缩略图（也就是鼠标所在的位置）。
  // 选择规则：先只留放得下大图的候选，再取面积最大的一块；面积相同时保留靠前的方向
  // （右 > 左 > 下 > 上），这样缩略图贴左边时优先往右展开，符合直觉。
  function pickRegion(thumb) {
    const t = thumb.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const gapRight = t.right + SAFE_GAP;
    const gapLeft = t.left - SAFE_GAP;
    const gapBottom = t.bottom + SAFE_GAP;
    const gapTop = t.top - SAFE_GAP;
    const regions = [
      { side: "right", left: gapRight, top: EDGE, width: vw - EDGE - gapRight, height: vh - EDGE * 2 },
      { side: "left", left: EDGE, top: EDGE, width: gapLeft - EDGE, height: vh - EDGE * 2 },
      { side: "bottom", left: EDGE, top: gapBottom, width: vw - EDGE * 2, height: vh - EDGE - gapBottom },
      { side: "top", left: EDGE, top: EDGE, width: vw - EDGE * 2, height: gapTop - EDGE },
    ];
    let best = null;
    for (const r of regions) {
      if (r.width < MIN_REGION || r.height < MIN_REGION) continue;
      if (!best || r.width * r.height > best.width * best.height) best = r;
    }
    if (best) return best;
    // 四块都太小（窗口特别窄/矮，或缩略图正好卡在中间）时，退而取面积最大的那块，
    // 图会小一些但依然不会盖住鼠标。
    for (const r of regions) {
      if (r.width <= 0 || r.height <= 0) continue;
      if (!best || r.width * r.height > best.width * best.height) best = r;
    }
    return best;
  }

  // 在可用区域里等比 contain，并把卡片贴到靠近缩略图的那一侧。
  // 大图还没加载完时先用缩略图自身的宽高比占位，避免图加载完再跳变。
  function fitImage() {
    if (!cardImg || !card) return;
    const thumb = activeThumb;
    const region = thumb ? pickRegion(thumb) : null;
    if (!region) return;
    const natW = cardImg.naturalWidth || (thumb && thumb.naturalWidth) || 0;
    const natH = cardImg.naturalHeight || (thumb && thumb.naturalHeight) || 0;
    let w;
    let h;
    if (natW > 0 && natH > 0) {
      const scale = Math.min(region.width / natW, region.height / natH, MAX_UPSCALE);
      w = natW * scale;
      h = natH * scale;
    } else {
      w = region.width * FLAT_RATIO;
      h = region.height * FLAT_RATIO;
    }
    w = Math.round(w);
    h = Math.round(h);
    // 贴着缩略图那一侧展开：右侧区域左对齐、左侧区域右对齐、上下区域水平居中；
    // 垂直方向同理——左右区域居中，上方区域贴底、下方区域贴顶。
    let offsetX = 0;
    if (region.side === "left") offsetX = region.width - w;
    else if (region.side !== "right") offsetX = (region.width - w) / 2;
    const left = region.left + Math.max(0, Math.min(offsetX, Math.max(0, region.width - w)));
    let offsetY = (region.height - h) / 2;
    if (region.side === "top") offsetY = region.height - h;
    else if (region.side === "bottom") offsetY = 0;
    const top = region.top + Math.max(0, Math.min(offsetY, Math.max(0, region.height - h)));
    card.style.left = Math.round(left) + "px";
    card.style.top = Math.round(top) + "px";
    card.style.width = w + "px";
    card.style.height = h + "px";
  }

  function showCard(thumb) {
    const src = thumbImageSrc(thumb);
    if (!src) return;
    ensureCard();
    activeThumb = thumb;

    // 换了图才重新设 src，同一张图反复 hover 不用重载
    if (cardImg.getAttribute("src") !== src) {
      cardImg.src = src;
      cardImg.onload = function () {
        if (activeThumb !== thumb) return;
        fitImage();
      };
      // 大图挂了就别把破图留在屏幕上
      cardImg.onerror = function () {
        if (activeThumb !== thumb) return;
        hideCard();
      };
    }

    fitImage();
    card.classList.add(WRAP_CLASS + "--shown");
    void card.offsetWidth; // 强制回流，保证 display:none → block 之后淡入过渡真的生效
    card.classList.add(WRAP_CLASS + "--visible");
  }

  function hideCard() {
    clearTimeout(showTimer);
    showTimer = 0;
    clearTimeout(hideTimer);
    hideTimer = 0;
    activeThumb = null;
    if (!card) return;
    card.classList.remove(WRAP_CLASS + "--visible");
    // 等淡出过渡走完再彻底收起来，不然会硬切
    clearTimeout(fadeTimer);
    fadeTimer = setTimeout(function () {
      if (card && !card.classList.contains(WRAP_CLASS + "--visible")) {
        card.classList.remove(WRAP_CLASS + "--shown");
        card.style.left = "";
        card.style.top = "";
        card.style.width = "";
        card.style.height = "";
      }
    }, FADE_MS + 20);
  }

  function scheduleHide() {
    if (hideTimer) return;
    hideTimer = setTimeout(function () {
      hideTimer = 0;
      hideCard();
    }, HIDE_DELAY);
  }

  // 统一入口：同一时刻只会有一个待执行的弹出计划
  function queueShow(thumb, delay) {
    clearTimeout(showTimer);
    showTimer = setTimeout(function () {
      showTimer = 0;
      if (activeThumb === thumb) return;
      showCard(thumb);
    }, delay);
  }

  // antd 会在图片上方盖一层 .ant-image-cover 遮罩，鼠标真正停在遮罩上，
  // 所以不能只就近找 img，还要顺着 .ant-image 容器把那张缩略图取出来。
  function thumbFrom(node) {
    if (!node || node.nodeType !== 1 || !node.closest) return null;
    const hit = node.closest(THUMB_SELECTOR);
    if (hit) return hit;
    const box = node.closest(".ant-image");
    if (!box || !box.querySelector) return null;
    return box.querySelector(THUMB_SELECTOR);
  }

  // 事件委托：翻页、换分类、SPA 路由切换后重新渲染的行都能自动生效
  document.addEventListener(
    "mouseover",
    function (e) {
      const thumb = thumbFrom(e.target);
      if (!thumb) return;
      clearTimeout(hideTimer);
      hideTimer = 0;
      // 站点原生的大图预览已经打开时，让位给它
      if (nativePreviewOpen()) {
        if (activeThumb) hideCard();
        return;
      }
      // 这一行没有封面（站点用占位图顶上），别让上一张图继续挂在那儿
      if (!thumbImageSrc(thumb)) {
        hideCard();
        return;
      }
      if (thumb === activeThumb) return;
      // 刚滚动过就先别弹：滚动会让浏览器重算 hover 并补发 mouseover，
      // 不挡一下的话，滚一次弹一次，屏幕被大图糊满
      if (Date.now() < mutedUntil) return;
      // 大图已经开着说明用户正在行间浏览，直接换内容，不用再等延迟
      if (isCardVisible()) {
        showCard(thumb);
      } else {
        queueShow(thumb, SHOW_DELAY);
      }
    },
    true
  );

  document.addEventListener(
    "mouseout",
    function (e) {
      const thumb = thumbFrom(e.target);
      if (!thumb) return;
      clearTimeout(showTimer);
      showTimer = 0;
      if (thumb !== activeThumb) return;
      // 鼠标只是在 img 和 antd 遮罩层之间挪动，不算移开
      const box = thumb.closest(".ant-image");
      const to = e.relatedTarget;
      if (to && box && box.contains(to)) return;
      scheduleHide();
    },
    true
  );

  // 用户仍可以点击缩略图使用站点原生的全屏预览，先把大图收掉免得多余
  document.addEventListener(
    "mousedown",
    function (e) {
      if (activeThumb && thumbFrom(e.target)) hideCard();
    },
    true
  );

  // 真正的滚动条不是 document 而是站点自己的 .ant-layout 容器，所以要挂捕获阶段。
  // 滚动会让浏览器重新计算 hover 目标、补发 mouseover，所以除了立即收起，
  // 还要在滚动期间短暂忽略悬停，否则大图会跟着滚动的行一路乱闪。
  window.addEventListener(
    "scroll",
    function () {
      mutedUntil = Date.now() + SCROLL_MUTE;
      clearTimeout(showTimer); // 待执行的弹出计划作废，等滚完再说
      showTimer = 0;
      if (activeThumb) hideCard();
    },
    true
  );

  window.addEventListener("resize", function () {
    if (activeThumb) fitImage();
  });
  window.addEventListener("blur", hideCard);

  // SPA 翻页、改筛选后旧行会被整个替换掉，这时鼠标事件不会再来，得主动收尸
  setInterval(function () {
    if (activeThumb && !activeThumb.isConnected) hideCard();
  }, 500);

  // 用 @grant none 直接跑在页面里最简单：自己插一张样式表，不依赖任何 GM API
  const style = document.createElement("style");
  style.textContent = CSS;
  (document.head || document.documentElement).appendChild(style);
})();
