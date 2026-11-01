#!/usr/bin/env node
/**
 * Non-production end-to-end smoke test for the Android-hosted OHLI API.
 * Uses two existing disposable accounts, two sessions per account, and cleans
 * up test posts/messages/stories/groups/channels. It leaves one uniquely tagged
 * activity-history record because the API intentionally exposes account-wide
 * clear, not per-event deletion. Never run this against primary accounts.
 */
const base = (process.env.OHLI_BASE_URL || 'http://127.0.0.1:8080').replace(/\/+$/, '');
const phoneA = String(process.env.OHLI_PHONE_A || '').replace(/\D/g, '');
const passA = process.env.OHLI_PASSWORD_A || '';
const phoneB = String(process.env.OHLI_PHONE_B || '').replace(/\D/g, '');
const passB = process.env.OHLI_PASSWORD_B || '';

if (!phoneA || !passA || !phoneB || !passB) {
  console.error('Isi OHLI_PHONE_A, OHLI_PASSWORD_A, OHLI_PHONE_B, dan OHLI_PASSWORD_B untuk dua akun uji.');
  process.exit(2);
}
if (phoneA === phoneB) {
  console.error('Akun A dan B harus berbeda.');
  process.exit(2);
}

let passed = 0;
const createdPostsA = [];
const createdMessagesA = [];
const createdStatusesA = [];
const createdCommunities = [];
let tokenA = '';
let tokenB = '';
let tokenADevice2 = '';
let tokenBDevice2 = '';
let originalDirectMessagesA = 'everyone';
let privacyAChanged = false;
let contactAtoBAdded = false;
const unique = 'OHLI_SMOKE_' + Date.now().toString(36).toUpperCase();

async function request(path, {method = 'GET', token, body, allowStatuses = []} = {}) {
  const url = new URL(path, base);
  if (method === 'GET' && token) url.searchParams.set('token', token);
  const headers = {Accept: 'application/json'};
  const config = {method, headers};
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json; charset=utf-8';
    config.body = JSON.stringify({...body, ...(token ? {token} : {})});
  }
  let response;
  try {
    response = await fetch(url, config);
  } catch (error) {
    throw new Error(`Tidak dapat menghubungi ${base}: ${error.message}`);
  }
  let data = {};
  try { data = await response.json(); } catch { /* non-JSON response checked below */ }
  if (!response.ok && !allowStatuses.includes(response.status)) {
    throw new Error(`${method} ${path} => HTTP ${response.status}: ${data.error || 'respons bukan JSON sukses'}`);
  }
  if (response.ok && data.ok === false && !allowStatuses.includes(response.status)) {
    throw new Error(`${method} ${path} => ${data.error || 'API mengembalikan ok:false'}`);
  }
  return {status: response.status, data};
}
function check(ok, message) {
  if (!ok) throw new Error(message);
  passed++;
  console.log(`PASS ${passed}: ${message}`);
}
async function login(phone, password) {
  const {data} = await request('/api/login', {method: 'POST', body: {phone, password}});
  if (!data.token) throw new Error('Login berhasil tetapi respons tidak berisi token.');
  return data.token;
}
async function createPost(token, text, audience = 'public') {
  const {data} = await request('/api/posts', {method: 'POST', token, body: {text, audience}});
  if (!data.post?.id) throw new Error('API tidak mengembalikan ID postingan baru.');
  if (token === tokenA) createdPostsA.push(data.post.id);
  return data.post;
}

try {
  const {data: health} = await request('/health');
  check(health.ok === true, 'health endpoint menjawab OK');
  tokenA = await login(phoneA, passA);
  tokenB = await login(phoneB, passB);
  tokenADevice2 = await login(phoneA, passA);
  tokenBDevice2 = await login(phoneB, passB);
  check(Boolean(tokenA && tokenB && tokenA !== tokenB && tokenADevice2 !== tokenA && tokenBDevice2 !== tokenB), 'dua akun dan sesi login kedua untuk simulasi perangkat dapat login');
  const ownChatMe = (await request('/api/me', {token: tokenA})).data;
  check(ownChatMe.phone === phoneA && Boolean(ownChatMe.name), 'profil Chat akun sendiri mengembalikan nomor hanya melalui sesi terautentikasi');
  const privateMe = await request('/api/me', {allowStatuses: [401]});
  check(privateMe.status === 401, 'endpoint profil pribadi tidak dapat dibuka tanpa sesi akun');

  // Social discovery must never expose phone numbers, even though Chat has a separate private directory.
  const socialUsersB = (await request('/api/social/users', {token: tokenB})).data.users || [];
  const socialA = socialUsersB.find(user => user.username && user.phone);
  check(socialUsersB.every(user => /^oh_[a-f0-9]{20}$/i.test(String(user.phone || '')) && user.phone !== phoneA && user.phone !== phoneB), 'daftar Social hanya mengembalikan ID publik oh_, bukan nomor telepon');

  const ownProfileA = (await request(`/api/profile?phone=${encodeURIComponent(phoneA)}`, {token: tokenA})).data;
  originalDirectMessagesA = ownProfileA.user?.privacy?.directMessages || 'everyone';
  await request('/api/settings/privacy', {method: 'POST', token: tokenA, body: {directMessages: 'private'}});
  privacyAChanged = true;
  const chatUsersPrivate = (await request('/api/users', {token: tokenB})).data.users || [];
  check(!chatUsersPrivate.some(user => String(user.phone) === phoneA), 'akun dengan DM privat tidak muncul pada direktori nomor Chat');
  const phoneProbe = await request(`/api/user-exists?phone=${encodeURIComponent(phoneA)}`, {token: tokenB});
  check(phoneProbe.data.exists === false && !phoneProbe.data.name, 'pemeriksaan nomor tidak membocorkan keberadaan akun yang menolak DM');
  const resolvePrivate = await request(`/api/chat/resolve?target=${encodeURIComponent(phoneA)}`, {token: tokenB, allowStatuses: [403]});
  check(resolvePrivate.status === 403, 'resolusi nomor untuk membuka Chat ditolak saat DM privat');
  await request('/api/settings/privacy', {method: 'POST', token: tokenA, body: {directMessages: 'everyone'}});
  const chatUsersAllowed = (await request('/api/users', {token: tokenB})).data.users || [];
  check(chatUsersAllowed.some(user => String(user.phone) === phoneA), 'nomor akun yang mengizinkan DM tersedia hanya pada direktori Chat');

  const noToken = await request('/api/feed', {allowStatuses: [401]});
  check(noToken.status === 401, 'endpoint feed menolak sesi tanpa token');

  // Server-persisted activity is visible to another login session of the same account, not another account.
  const activityClientId = `${unique}_ACTIVITY_CLIENT`;
  await request('/api/activity/history', {method: 'POST', token: tokenA, body: {type: 'search', id: unique, label: `${unique}_HISTORY`, query: unique, clientId: activityClientId}});
  await request('/api/activity/history', {method: 'POST', token: tokenA, body: {type: 'search', id: unique, label: `${unique}_HISTORY_UPDATED`, query: unique, clientId: activityClientId}});
  const historyADevice2 = (await request('/api/activity/history', {token: tokenADevice2})).data.activities || [];
  const historyMatches = historyADevice2.filter(item => item.query === unique);
  check(historyMatches.length === 1 && historyMatches[0].label === `${unique}_HISTORY_UPDATED`, 'riwayat tersimpan lintas sesi akun dan retry tidak menggandakan event');
  const historyB = (await request('/api/activity/history', {token: tokenB})).data.activities || [];
  check(!historyB.some(item => item.query === unique), 'riwayat aktivitas akun A tidak terlihat oleh akun B');

  // A friend can pin/archive an active public Story; collections remain on the server across sessions.
  const story = (await request('/api/status', {method: 'POST', token: tokenA, body: {text: `${unique}_STORY`, audience: 'public', destination: 'social'}})).data.status;
  if (!story?.id) throw new Error('Story uji tidak mengembalikan ID.');
  createdStatusesA.push(story.id);
  const visibleStoriesB = (await request('/api/status?surface=social', {token: tokenB})).data.statuses || [];
  check(visibleStoriesB.some(item => item.id === story.id), 'Story publik akun A terlihat oleh akun B');
  await request('/api/status/collections', {method: 'POST', token: tokenB, body: {statusId: story.id, action: 'pin'}});
  await request('/api/status/collections', {method: 'POST', token: tokenB, body: {statusId: story.id, action: 'archive'}});
  const pinnedOnDevice2 = (await request('/api/status/collections?mode=pinned', {token: tokenBDevice2})).data.items || [];
  const archivedOnDevice2 = (await request('/api/status/collections?mode=archived', {token: tokenBDevice2})).data.items || [];
  check(pinnedOnDevice2.some(item => item.statusId === story.id) && archivedOnDevice2.some(item => item.statusId === story.id), 'pin dan arsip Story tersimpan server dan terlihat dari sesi kedua');
  await request('/api/status/collections', {method: 'POST', token: tokenB, body: {statusId: story.id, action: 'unpin'}});
  await request('/api/status/collections', {method: 'POST', token: tokenB, body: {statusId: story.id, action: 'unarchive'}});
  const clearedStoryCollection = (await request('/api/status/collections', {token: tokenBDevice2})).data.items || [];
  check(!clearedStoryCollection.some(item => item.statusId === story.id), 'Story keluar dari koleksi setelah pin dan arsip dilepas');
  await request('/api/status/delete', {method: 'POST', token: tokenA, body: {statusId: story.id}});
  createdStatusesA.splice(createdStatusesA.indexOf(story.id), 1);
  check(true, 'pemilik dapat menghapus Story uji setelah koleksi dibersihkan');

  // A true server-claimed 1x text can be opened only once, including from a second login session.
  const onceText = `${unique}_VIEW_ONCE_TEXT`;
  const onceMessage = (await request('/api/messages', {method: 'POST', token: tokenA, body: {recipient: phoneB, text: `\u2063RKM1X\u2063${onceText}`}})).data.message;
  if (!onceMessage?.id) throw new Error('Pesan teks 1× tidak mengembalikan ID pesan.');
  createdMessagesA.push(onceMessage.id);
  const receiverMessages = (await request(`/api/messages?peer=${encodeURIComponent(phoneA)}`, {token: tokenB})).data.messages || [];
  const onceInList = receiverMessages.find(item => item.id === onceMessage.id);
  check(Boolean(onceInList?.viewOnce) && onceInList.text === '', 'isi pesan teks 1× disembunyikan sebelum penerima mengklaimnya');
  const firstOpen = (await request('/api/messages/once/open', {method: 'POST', token: tokenB, body: {id: onceMessage.id}})).data;
  check(firstOpen.opened === true && firstOpen.text === onceText, 'klaim pertama pesan teks 1× mengembalikan isi pesan');
  const secondDeviceOpen = await request('/api/messages/once/open', {method: 'POST', token: tokenBDevice2, body: {id: onceMessage.id}, allowStatuses: [410]});
  check(secondDeviceOpen.status === 410, 'klaim kedua dari sesi/perangkat login lain ditolak HTTP 410');
  const onceAfterOpen = (await request(`/api/messages?peer=${encodeURIComponent(phoneA)}`, {token: tokenBDevice2})).data.messages || [];
  const onceAfterOpenRow = onceAfterOpen.find(item => item.id === onceMessage.id);
  check(Boolean(onceAfterOpenRow?.viewOnceOpened) && onceAfterOpenRow.text === '', 'status 1× tetap terkunci pada sesi kedua setelah pembukaan pertama');

  // Group room: invite a saved Chat friend during creation, manage membership, chat and poll.
  await request('/api/contacts', {method: 'POST', token: tokenA, body: {action: 'add', phone: phoneB, alias: `${unique} FRIEND`}});
  contactAtoBAdded = true;
  const contactRows = (await request('/api/contacts', {token: tokenA})).data.contacts || [];
  const inviteSocialId = contactRows.find(item => String(item.phone) === phoneB)?.socialId;
  check(Boolean(inviteSocialId) && /^oh_[a-f0-9]{20}$/i.test(inviteSocialId), 'kontak Chat memberi kunci undangan Social yang tidak menampilkan nomor');
  const group = (await request('/api/groups', {method: 'POST', token: tokenA, body: {name: `${unique} GROUP`, description: 'Grup uji otomatis', privacy: 'private', memberPhones: [inviteSocialId]}})).data.item;
  if (!group?.id) throw new Error('Grup uji tidak mengembalikan ID.');
  createdCommunities.push({kind: 'group', id: group.id});
  check(group.memberCount === 2, 'pembuatan grup menambahkan teman pilihan dari Kontak Chat sejak awal');
  const invitedMembers = (await request(`/api/groups/members?groupId=${encodeURIComponent(group.id)}`, {token: tokenB})).data.members || [];
  check(invitedMembers.some(item => item.isMe) && invitedMembers.every(item => !Object.prototype.hasOwnProperty.call(item, 'phone')), 'anggota undangan dapat melihat daftar anggota tanpa nomor telepon publik');
  const membersForOwner = (await request(`/api/groups/members?groupId=${encodeURIComponent(group.id)}`, {token: tokenA})).data.members || [];
  const memberB = membersForOwner.find(item => !item.isOwner);
  if (!memberB?.id) throw new Error('Anggota undangan tidak ditemukan untuk tes hapus/tambah.');
  await request('/api/groups/members', {method: 'POST', token: tokenA, body: {groupId: group.id, action: 'remove', target: memberB.id}});
  const removedAccess = await request(`/api/groups/messages?groupId=${encodeURIComponent(group.id)}`, {token: tokenB, allowStatuses: [403]});
  check(removedAccess.status === 403, 'anggota yang dikeluarkan tidak lagi dapat membuka ruang grup privat');
  const readded = (await request('/api/groups/members', {method: 'POST', token: tokenA, body: {groupId: group.id, action: 'add', phones: [inviteSocialId]}})).data;
  check(readded.added === 1, 'pemilik dapat menambahkan kembali teman tersimpan ke grup');
  const joinedGroup = (await request(`/api/groups/messages?groupId=${encodeURIComponent(group.id)}`, {token: tokenB})).data.group;
  check(Boolean(joinedGroup?.joined), 'teman yang ditambahkan dapat membuka ruang grup setelah diundang');
  const groupText = (await request('/api/groups/messages', {method: 'POST', token: tokenB, body: {groupId: group.id, text: `${unique}_GROUP_MESSAGE`}})).data.message;
  check(Boolean(groupText?.id), 'pesan grup dari anggota tersimpan');
  const poll = (await request('/api/groups/messages', {method: 'POST', token: tokenA, body: {groupId: group.id, kind: 'poll', question: `${unique}_POLL`, options: ['Pilihan A', 'Pilihan B']}})).data.message;
  if (!poll?.id || !Array.isArray(poll.options) || poll.options.length !== 2) throw new Error('Polling grup tidak dibuat sesuai dua pilihan.');
  await request('/api/groups/vote', {method: 'POST', token: tokenB, body: {groupId: group.id, messageId: poll.id, optionId: poll.options[0].id}});
  await request('/api/groups/vote', {method: 'POST', token: tokenB, body: {groupId: group.id, messageId: poll.id, optionId: poll.options[1].id}});
  const groupMessagesB = (await request(`/api/groups/messages?groupId=${encodeURIComponent(group.id)}`, {token: tokenB})).data.messages || [];
  const pollAfterVote = groupMessagesB.find(message => message.id === poll.id);
  check(Boolean(pollAfterVote) && pollAfterVote.options.filter(option => option.votedByMe).length === 1 && pollAfterVote.options.find(option => option.votedByMe)?.id === poll.options[1].id, 'polling grup menyimpan satu pilihan aktif per anggota');
  const groupMessagesA = (await request(`/api/groups/messages?groupId=${encodeURIComponent(group.id)}`, {token: tokenA})).data.messages || [];
  check(groupMessagesA.some(message => message.text === `${unique}_GROUP_MESSAGE`), 'pesan anggota tampil pada ruang grup milik akun A');
  const groupDeleteAsB = await request('/api/groups/delete', {method: 'POST', token: tokenB, body: {id: group.id}, allowStatuses: [403]});
  check(groupDeleteAsB.status === 403, 'anggota biasa tidak dapat menghapus grup milik orang lain');
  await request('/api/groups/delete', {method: 'POST', token: tokenA, body: {id: group.id}});
  createdCommunities.splice(createdCommunities.findIndex(item => item.id === group.id), 1);
  check(true, 'pemilik dapat menghapus grup dan membersihkan pesan pollingnya');

  // Channel broadcast: only owner publishes; followers can read and react.
  const channel = (await request('/api/channels', {method: 'POST', token: tokenA, body: {name: `${unique} CHANNEL`, description: 'Channel uji otomatis', privacy: 'public'}})).data.item;
  if (!channel?.id) throw new Error('Channel uji tidak mengembalikan ID.');
  createdCommunities.push({kind: 'channel', id: channel.id});
  const followed = (await request('/api/channels/follow', {method: 'POST', token: tokenB, body: {id: channel.id, action: 'follow'}})).data;
  check(followed.joined === true, 'akun B dapat mengikuti Channel publik');
  const channelPost = (await request('/api/channels/posts', {method: 'POST', token: tokenA, body: {channelId: channel.id, text: `${unique}_CHANNEL_POST`}})).data.post;
  check(Boolean(channelPost?.id), 'pemilik dapat menerbitkan pengumuman Channel');
  const channelRead = (await request(`/api/channels/posts?channelId=${encodeURIComponent(channel.id)}`, {token: tokenB})).data;
  check((channelRead.posts || []).some(post => post.id === channelPost.id), 'pengikut dapat membaca siaran Channel');
  const notOwnerPost = await request('/api/channels/posts', {method: 'POST', token: tokenB, body: {channelId: channel.id, text: `${unique}_FORBIDDEN_POST`}, allowStatuses: [403]});
  check(notOwnerPost.status === 403, 'pengikut tidak dapat menerbitkan pesan ke Channel satu arah');
  const reacted = (await request('/api/channels/react', {method: 'POST', token: tokenB, body: {channelId: channel.id, postId: channelPost.id, emoji: '🔥'}})).data.post;
  const fireReaction = (reacted.reactionSummary || []).find(item => item.emoji === '🔥');
  check(Boolean(fireReaction) && fireReaction.count === 1 && fireReaction.mine === true, 'reaksi emoji Channel tersimpan dan dihitung');
  const channelDeleteAsB = await request('/api/channels/delete', {method: 'POST', token: tokenB, body: {id: channel.id}, allowStatuses: [403]});
  check(channelDeleteAsB.status === 403, 'pengikut tidak dapat menghapus Channel milik orang lain');
  await request('/api/channels/delete', {method: 'POST', token: tokenA, body: {id: channel.id}});
  createdCommunities.splice(createdCommunities.findIndex(item => item.id === channel.id), 1);
  check(true, 'pemilik dapat menghapus Channel dan membersihkan postingannya');

  const publicPost = await createPost(tokenA, `${unique}_PUBLIC`, 'public');
  const privatePost = await createPost(tokenA, `${unique}_PRIVATE`, 'private');
  const feedB = (await request('/api/feed?mode=public', {token: tokenB})).data.posts || [];
  check(feedB.some(p => p.id === publicPost.id), 'posting publik akun A terlihat oleh akun B');
  check(!feedB.some(p => p.id === privatePost.id), 'posting privat akun A tidak terlihat pada feed akun B');

  const profileB = (await request(`/api/profile?phone=${encodeURIComponent(phoneA)}`, {token: tokenB})).data;
  check((profileB.posts || []).some(p => p.id === publicPost.id), 'profil menampilkan postingan yang boleh dilihat');
  check(!(profileB.posts || []).some(p => p.id === privatePost.id), 'profil tidak membocorkan postingan privat');

  const crossEdit = await request('/api/posts/edit', {method: 'POST', token: tokenB, body: {postId: publicPost.id, text: 'UNAUTHORIZED_EDIT', audience: 'public'}, allowStatuses: [403]});
  check(crossEdit.status === 403, 'akun B tidak dapat mengedit postingan milik akun A');
  const crossArchive = await request('/api/posts/archive', {method: 'POST', token: tokenB, body: {postId: publicPost.id, action: 'archive'}, allowStatuses: [403]});
  check(crossArchive.status === 403, 'akun B tidak dapat mengarsipkan postingan milik akun A');
  const crossDelete = await request('/api/posts/delete', {method: 'POST', token: tokenB, body: {postId: publicPost.id}, allowStatuses: [403]});
  check(crossDelete.status === 403, 'akun B tidak dapat menghapus postingan milik akun A');

  const liked = (await request('/api/posts/like', {method: 'POST', token: tokenB, body: {postId: publicPost.id}})).data;
  check(liked.liked === true, 'like dapat ditambahkan oleh akun B');
  const unliked = (await request('/api/posts/like', {method: 'POST', token: tokenB, body: {postId: publicPost.id}})).data;
  check(unliked.liked === false, 'like dapat dibatalkan oleh akun B');

  const comment = (await request('/api/posts/comment', {method: 'POST', token: tokenB, body: {postId: publicPost.id, text: `${unique}_COMMENT`}})).data;
  check(Boolean(comment.comment?.id), 'komentar tersimpan pada postingan');

  const saved = (await request('/api/posts/bookmark', {method: 'POST', token: tokenB, body: {postId: publicPost.id}})).data;
  check(saved.saved === true, 'bookmark pribadi dapat dibuat');
  const savedList = (await request('/api/posts/saved', {token: tokenB})).data.posts || [];
  check(savedList.some(p => p.id === publicPost.id), 'bookmark muncul di daftar tersimpan milik akun B');
  const unsaved = (await request('/api/posts/bookmark', {method: 'POST', token: tokenB, body: {postId: publicPost.id}})).data;
  check(unsaved.saved === false, 'bookmark dapat dihapus');

  const follow = (await request('/api/follow', {method: 'POST', token: tokenB, body: {target: phoneA, action: 'follow'}})).data;
  check(follow.following === true, 'akun B dapat mengikuti akun A');
  const unfollow = (await request('/api/follow', {method: 'POST', token: tokenB, body: {target: phoneA, action: 'unfollow'}})).data;
  check(unfollow.following === false, 'akun B dapat berhenti mengikuti akun A');

  // Verify archive/restore persistence, then restore so no test post remains hidden.
  const archive = (await request('/api/posts/archive', {method: 'POST', token: tokenA, body: {postId: publicPost.id, action: 'archive'}})).data;
  check(archive.archived === true, 'pemilik dapat mengarsipkan postingan');
  const archiveList = (await request('/api/posts/archive', {token: tokenA})).data.posts || [];
  check(archiveList.some(p => p.id === publicPost.id), 'postingan ada pada arsip privat pemilik');
  const restore = (await request('/api/posts/archive', {method: 'POST', token: tokenA, body: {postId: publicPost.id, action: 'restore'}})).data;
  check(restore.archived === false, 'pemilik dapat memulihkan postingan dari arsip');

  console.log(`\nBerhasil: ${passed} pemeriksaan API.`);
} catch (error) {
  console.error(`\nGAGAL setelah ${passed} pemeriksaan: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (tokenA && privacyAChanged) {
    try { await request('/api/settings/privacy', {method: 'POST', token: tokenA, body: {directMessages: originalDirectMessagesA}}); } catch {}
  }
  if (tokenA && contactAtoBAdded) {
    try { await request('/api/contacts', {method: 'POST', token: tokenA, body: {action: 'delete', phone: phoneB}}); } catch {}
  }
  if (tokenB) {
    // Remove any test-post bookmarks left behind if a check failed midway.
    try {
      const savedPosts = (await request('/api/posts/saved', {token: tokenB})).data.posts || [];
      for (const id of createdPostsA) {
        if (savedPosts.some(post => post.id === id)) {
          await request('/api/posts/bookmark', {method: 'POST', token: tokenB, body: {postId: id}});
        }
      }
    } catch { /* cleanup is best-effort if server connectivity is lost */ }
  }
  if (tokenA) {
    for (const statusId of createdStatusesA) {
      if (tokenB) {
        for (const action of ['unpin', 'unarchive', 'remove']) {
          try { await request('/api/status/collections', {method: 'POST', token: tokenB, body: {statusId, action}}); } catch {}
        }
      }
      try { await request('/api/status/delete', {method: 'POST', token: tokenA, body: {statusId}}); } catch {}
    }
    for (const item of createdCommunities) {
      try { await request(item.kind === 'group' ? '/api/groups/delete' : '/api/channels/delete', {method: 'POST', token: tokenA, body: {id: item.id}}); } catch {}
    }
    for (const id of createdMessagesA) {
      try { await request('/api/messages/delete', {method: 'POST', token: tokenA, body: {id}}); } catch {}
    }
    for (const id of createdPostsA) {
      try { await request('/api/posts/archive', {method: 'POST', token: tokenA, body: {postId: id, action: 'restore'}}); } catch {}
      try { await request('/api/posts/delete', {method: 'POST', token: tokenA, body: {postId: id}}); } catch {}
    }
  }
}
