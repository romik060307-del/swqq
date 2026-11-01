#!/usr/bin/env node
/** Static verification for the OHLI Social Android source. No server/account required. */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
let passed = 0;
function check(condition, message) {
  if (!condition) throw new Error(`FAIL: ${message}`);
  passed += 1;
  console.log(`PASS ${passed}: ${message}`);
}
function checkCssBraces(css) {
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const stack = [];
  let quote = null, escaped = false;
  for (let i = 0; i < css.length; i += 1) {
    const ch = css[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '{') stack.push(i);
    else if (ch === '}') {
      if (!stack.length) return false;
      stack.pop();
    }
  }
  return stack.length === 0 && quote === null;
}

const js = read('app/src/main/assets/ohli-social.js');
new vm.Script(js, {filename: 'ohli-social.js'});
check(true, 'JavaScript OHLI Social dapat diparse');

const html = read('app/src/main/assets/index.html');
const inlineStyles = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)].map((m) => m[1]);
check(inlineStyles.length > 0 && inlineStyles.every(checkCssBraces), `${inlineStyles.length} blok CSS inline HTML seimbang`);
const inlineScripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)].map((m) => m[1]).filter((s) => s.trim());
for (let i = 0; i < inlineScripts.length; i += 1) new vm.Script(inlineScripts[i], {filename: `index-inline-${i + 1}.js`});
check(inlineScripts.length > 0, `${inlineScripts.length} skrip inline HTML dapat diparse`);
check(checkCssBraces(read('app/src/main/assets/ohli-social.css')), 'Kurung blok CSS Social seimbang');

const java = read('app/src/main/java/com/rk/server/ServerService.java');
for (const [needle, message] of [
  ['/api/activity/history', 'endpoint riwayat server tersedia'],
  ['/api/social/users', 'endpoint penemuan akun Social terpisah dari Chat tersedia'],
  ['private void getChatUsers', 'endpoint daftar Chat memakai serializer nomor privat'],
  ['private void getSocialUsers', 'endpoint daftar Social memakai ID publik'],
  ['boolean allowed=u!=null', 'pencarian nomor menggunakan hasil izin akses'],
  ['&&canDirectMessage(me.optString("phone"),phone)', 'pencarian nomor tidak mengungkap akun yang melarang DM'],
  ['ohli-activity-history.json', 'riwayat memiliki penyimpanan server'],
  ['/api/status/collections', 'endpoint koleksi Story tersedia'],
  ['/api/status/delete', 'penghapusan Story milik sendiri tersedia'],
  ['/api/groups/delete', 'penghapusan grup oleh pemilik tersedia'],
  ['/api/channels/delete', 'penghapusan Channel oleh pemilik tersedia'],
  ['ohli-story-collections.json', 'pin/arsip Story memiliki penyimpanan server'],
  ['/api/messages/once/open', 'endpoint klaim teks sekali lihat tersedia'],
  ['viewOnceSessionKey', 'media 1× memiliki kunci sesi server'],
  ['if(!onceSessionKey.matches("[a-fA-F0-9]{32}"))', 'media 1× menolak permintaan tanpa kunci sesi'],
  ['safe.put("text","")', 'isi teks 1× disamarkan dari daftar chat penerima'],
  ['r.put("phone",id)', 'API Social mengganti nomor dengan ID publik stabil'],
  ['/api/groups/vote', 'endpoint pemungutan suara grup tersedia'],
  ['/api/channels/react', 'endpoint reaksi Channel tersedia'],
  ['canDirectMessage(sender,recipient)', 'aturan DM diperiksa di server saat pengiriman'],
]) {
  if (!message) continue;
  check(java.includes(needle), message);
}
const postSerializer = java.slice(java.indexOf('private JSONObject publicPost'), java.indexOf('private double socialPostRank'));
check(postSerializer.includes('p.put("author",authorUser==null?"":socialId(authorUser))'), 'nomor penulis postingan tidak bocor bahkan kepada pemiliknya');
check(postSerializer.includes('sc.put("phone",cu==null?"":socialId(cu))') && postSerializer.includes('sl.put("phone",lu==null?"":socialId(lu))') && postSerializer.includes('sr.put("phone",ru==null?"":socialId(ru))'), 'nomor pemberi komentar, like, dan repost disamarkan');
check(java.includes('row.put("repostedBy",repostUser==null?"":socialId(repostUser))'), 'penanda repost tidak mengembalikan nomor akun sendiri');
check(java.includes('safeComment.put("phone",socialId(me))') && java.includes('p.put("authorName",socialDisplayName(authorUser))') && java.includes('socialDisplayName(JSONObject u)'), 'respons komentar dan nama penulis Social disanitasi, termasuk akun lama yang nama tampilannya berupa nomor');
check(java.includes('publicStatus.put("phone",socialId(me))') && java.includes('safeHighlight.put("owner",socialId(me))'), 'respons publik pembuatan Story dan Sorotan tidak membocorkan nomor');
const channelSerializer = java.slice(java.indexOf('private JSONObject publicChannelPost'), java.indexOf('private void getChannelPosts'));
check(channelSerializer.includes('p.put("author",author==null?"":socialId(author))') && channelSerializer.includes('sr.put("phone",ru==null?"":socialId(ru))'), 'nomor penulis dan pemberi reaksi Channel selalu disamarkan');
check(java.includes('safe.put("sender",senderUser==null?"":socialId(senderUser))') && java.includes('safe.put("name",socialDisplayName(senderUser))'), 'respons Grup menampilkan ID sosial dan nama aman');
const statusSerializer = java.slice(java.indexOf('private void getStatuses'), java.indexOf('private void getImage'));
check(statusSerializer.includes('safe.put("phone",statusOwner==null?"":socialId(statusOwner))') && statusSerializer.includes('sl.put("phone",lu==null?"":socialId(lu))'), 'nomor pemilik dan pemberi like Story Social selalu disamarkan');
const socialUi = read('app/src/main/assets/ohli-social.js');
check(socialUi.includes("rt.request('/api/social/users')") && !socialUi.includes("rt.request('/api/users')"), 'UI Social tidak lagi meminta daftar nomor telepon Chat');
check(socialUi.includes('(s.isMine||s.phone===me.phone)') && socialUi.includes("var freshStories=await rt.request('/api/status?surface=social')"), 'UI Story mengenali Story sendiri tanpa mengandalkan nomor telepon');
check(socialUi.includes('isMine:items.some(function(s){return s.isMine===true;})') && socialUi.includes('isMine=!!p.isMine') && socialUi.includes('canManage=!!c.isMine||!!p.isMine'), 'UI feed, Story, dan komentar memakai penanda isMine saat nomor disamarkan');
const onceOpen = java.slice(java.indexOf('private void openViewOnceMessage'), java.indexOf('private void markMessagesRead'));
check(onceOpen.includes('viewOnceOpenedAt') && onceOpen.includes('410'), 'klaim kedua teks 1× ditolak server');
const media = java.slice(java.indexOf('private void getMedia'), java.indexOf('private void getImage'));
check(media.includes('viewOnceSessionKey') && media.includes('10L*60L*1000L') && media.includes('Cache-Control: no-store'), 'media 1× mendukung Range untuk sesi yang sama dan no-store');
const poll = java.slice(java.indexOf('private void voteGroupPoll'), java.indexOf('private JSONObject publicChannelPost'));
check(poll.indexOf('if(!validOption)') < poll.indexOf('option.put("votes",next)'), 'poll memvalidasi opsi sebelum mengubah suara');
const channelReact = java.slice(java.indexOf('private void toggleChannelReaction'), java.indexOf('private void createChannelPost'));
check(channelReact.includes('!\"public\".equals(channel.optString(\"privacy\"') && channelReact.includes('followers'), 'reaksi Channel memeriksa akses Channel privat');

const finalChatCss = html.slice(html.indexOf('id=\"ohli-v330-unified-instagram-ui\"'));
check(finalChatCss.includes('SF Pro Text') && finalChatCss.includes('#fafafa') && finalChatCss.includes('#0095f6'), 'tema terang minimalis dan font sistem Apple berlaku sebagai override paling akhir');
check(finalChatCss.includes('body .auth-screen{background:#fafafa!important}') && finalChatCss.includes('body .call-overlay{background:#fafafa!important'), 'halaman login dan panggilan mengikuti tema netral yang sama');
check(finalChatCss.includes('#app .my-profile{display:flex!important') && finalChatCss.includes('#ohliSocialShell .ohli-sidebar{background:#fff!important'), 'profil diri Chat dan navigasi Social tidak disembunyikan tema lama');
check(java.includes('r.put("name",socialDisplayName(u))') && socialUi.includes("topName=String(me.name||'').trim()"), 'nama akun lama yang sama dengan nomor tidak tampil sebagai identitas Social');
check(socialUi.includes('async function loadGroupInviteOptions') && socialUi.includes("rt.request('/api/contacts')") && socialUi.includes("rt.request('/api/social/users')"), 'pemilih grup menggabungkan kontak Chat dan koneksi Social');
check(socialUi.includes("digits===String(c.phone||'').replace(/\\D/g,'')") && socialUi.includes("name=c.username?'@'+c.username:'Pengguna OHLI'"), 'pemilih teman Social tidak menampilkan nomor ketika nama akun lama sama dengan nomor');
check(java.includes('row.put(\"followsYou\",isFollowing(target,viewer))') && java.includes('canInviteToGroup(owner,target)'), 'backend mengizinkan undangan kontak atau koneksi Social yang berelasi');
check(socialUi.includes('async function showCommunityForm') && socialUi.includes('name=\"memberPhones\"'), 'formulir buat grup mengirim teman pilihan sebagai ID sosial');
check(socialUi.includes('async function showGroupMemberPicker') && socialUi.includes('loadGroupInviteOptions()') && socialUi.includes("'/api/groups/members'"), 'pemilik grup dapat menambah kontak atau koneksi Social setelah grup dibuat');
check(socialUi.includes('data-action=\"group-members\"') && socialUi.includes('data-action=\"group-add-members\"'), 'ruang grup menampilkan aksi anggota dan tambah teman');
check(html.includes('id=\"myProfileButton\"') && html.includes('async function openMyChatProfile') && html.includes('/api/me'), 'profil diri Chat memuat nomor pribadi dari endpoint akun terautentikasi');
check(html.includes('id=\"editUsername\"') && html.includes('username:username'), 'username Social bisa diedit dari profil akun Chat');
check(!socialUi.includes('toggle-liquid-glass": [') && !socialUi.includes('Warna aksen utama<input name=\"accent\" type=\"color\"'), 'kontrol warna yang tidak selaras dihapus dari pengaturan Social');
const gradle = read('app/build.gradle');
check(gradle.includes("versionCode 25") && gradle.includes("versionName '3.4.0'"), 'identitas build Android sesuai v3.4.0');
const smoke = read('tools/smoke-test.mjs');
for (const [needle, message] of [
  ["'/api/social/users'", 'tes integrasi memeriksa direktori Social tanpa nomor'],
  ["'/api/activity/history'", 'tes integrasi memeriksa riwayat lintas sesi'],
  ["'/api/status/collections'", 'tes integrasi memeriksa pin dan arsip Story'],
  ["'/api/messages/once/open'", 'tes integrasi memeriksa klaim View Once dari sesi kedua'],
  ["'/api/groups/members'", 'tes integrasi memeriksa tambah dan keluarkan anggota grup'],
  ["'/api/me'", 'tes integrasi memeriksa data profil pribadi Chat'],
  ["'/api/groups/vote'", 'tes integrasi memeriksa polling grup'],
  ["'/api/channels/react'", 'tes integrasi memeriksa reaksi Channel'],
  ["'/api/groups/delete'", 'tes integrasi membersihkan grup uji'],
  ["'/api/channels/delete'", 'tes integrasi membersihkan Channel uji'],
]) check(smoke.includes(needle), message);
const workflow = read('.github/workflows/build-apk.yml');
check(workflow.includes('OHLI-Social-Source-v3.4.0.zip'), 'workflow GitHub Actions memprioritaskan arsip v3.4.0');
check(socialUi.includes('async function downloadVideoWithWatermark') && socialUi.includes("'OHLI'") && socialUi.includes('allowDownload===false'), 'unduhan membuat salinan video ber-watermark OHLI dan memeriksa izin pemilik');
check(java.includes('"1".equals(queryParam(query,"download")) && !post.optBoolean("allowDownload",true)'), 'server tetap menolak unduhan bila pemilik menonaktifkannya');
check(socialUi.includes('profileVideoLayout') && socialUi.includes('data-action="profile-media-mode"') && socialUi.includes('is-transparent') && socialUi.includes('is-limited'), 'profil menyediakan mode video Transparan dan Terbatas');
check(socialUi.includes('data-action="reply-comment"') && socialUi.includes('data-action="like-comment"') && socialUi.includes("'/api/posts/comments/like'"), 'komentar mendukung balasan bertingkat dan like server-side');
check(socialUi.includes("'/api/stickers/favorites'") && socialUi.includes('data-comment-sticker-file') && java.includes('private void toggleStickerFavorite'), 'stiker bawaan, impor, dan koleksi favorit terhubung ke server');
check(html.includes('function liveModalHtml') && html.includes('function openRkmLivePreview') && html.includes('rkmLiveQuality') && html.includes('rkmLiveFlip') && html.includes('/api/live/comment'), 'studio LIVE mengatur kamera, mikrofon, kualitas, dan komentar realtime');
check(html.includes('new RTCPeerConnection') && html.includes('maksimal 6 penonton langsung') && html.includes('/api/live/signal'), 'LIVE memakai signaling WebRTC P2P nyata dan menjelaskan batas kapasitasnya');
check(html.includes('var wasAtBottom=(mainBody.scrollHeight-mainBody.scrollTop-mainBody.clientHeight)<110') && html.includes('shouldFollow=arr.length&&(wasAtBottom||peerChanged)'), 'Chat otomatis ke pesan terbaru tanpa melompat saat pengguna membaca pesan lama');
check(socialUi.includes('function onCommentHoldStart') && socialUi.includes('function replyToComment') && socialUi.includes('setTimeout(function(){commentHoldConsumed=true'), 'menahan komentar membuka alur Balas');
check(socialUi.includes('function onStoryHoldStart') && socialUi.includes('function pauseStoryPlayback') && socialUi.includes('function resumeStoryPlayback'), 'Story dijeda saat ditahan dan dilanjutkan dari posisi saat dilepas');
check(html.includes('function mediaTarget') && html.includes("e.target.closest('#ohliSocialShell .ohli-comment')") && html.includes('selectstart'), 'menu Copy bawaan diblokir hanya pada video dan teks komentar Social');
check(html.includes('body.v5-dark') && html.includes('#ohliSocialShell.ohli-dark') && html.includes('setTheme:function(next)'), 'Mode Malam tersimpan dan mencakup Chat serta Social');
check(html.includes('ohli-comment-actions') && html.includes('visualViewport') && socialUi.includes('data-comment-id="\'+esc(c.id)'), 'panel komentar punya aksi berjarak, balasan tahan, dan penyesuaian keyboard HP');
console.log(`\nLulus ${passed} pemeriksaan statis. Ini bukan pengganti build APK atau tes runtime pada dua perangkat.`);
