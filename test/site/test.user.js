// ==UserScript==
// @name         Sapphire TM Test
// @namespace    sapphire
// @version      1.0
// @match        http://127.0.0.1:5200/index.html
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        unsafeWindow
// ==/UserScript==
unsafeWindow.__tmRan = { gm: typeof GM_setValue, v: (GM_setValue("a", 7), GM_getValue("a")), title: document.title };
