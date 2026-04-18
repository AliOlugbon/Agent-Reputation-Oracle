/* ═══════════════════════════════════════════════════════════════
   Agent Reputation Oracle — app.js
   Single contract · viem ESM · MiniPay · Celo · EIP-712 · cUSD
   ═══════════════════════════════════════════════════════════════ */

// ── Two addresses only (was 6) ────────────────────────────────
// Paste oracle address after: mox run deploy --network celo-mainnet
const ADDR = {
  Oracle: "0x87928a1987Da9C2a144161509B41126cE58e13ea",
  cUSD:   "0x765DE816845861e75A25fCA122bb6898B8B1282a",
};

const CELO_CHAIN_ID = 42220;
const CELO_RPC      = "https://forno.celo.org";
const POLL_MS       = 15_000;

const CAP_TAGS = {
  defi_trading:  { label: "DeFi Trading",  emoji: "📈" },
  nft_valuation: { label: "NFT Valuation", emoji: "🖼"  },
  governance:    { label: "Governance",    emoji: "🗳"  },
  bridge:        { label: "Cross-Chain",   emoji: "🌉"  },
  prediction:    { label: "Prediction",    emoji: "🔮"  },
};

// ── ABI — one contract, every function the frontend calls ─────
const ORACLE_ABI = [
  // Identity
  { type:"function", name:"registerAgent",  stateMutability:"nonpayable",
    inputs:[{name:"agent",type:"address"},{name:"metadata",type:"string"}], outputs:[] },
  { type:"function", name:"isRegistered",   stateMutability:"view",
    inputs:[{name:"agent",type:"address"}], outputs:[{type:"bool"}] },
  { type:"function", name:"getAgent",       stateMutability:"view",
    inputs:[{name:"agent",type:"address"}],
    outputs:[{type:"tuple",components:[
      {name:"owner",type:"address"},{name:"metadata",type:"string"},
      {name:"registered",type:"uint256"},{name:"active",type:"bool"},
    ]}]},
  // Reputation
  { type:"function", name:"submitFeedback", stateMutability:"nonpayable",
    inputs:[{name:"agent",type:"address"},{name:"score",type:"uint8"},
            {name:"tag",type:"bytes32"},{name:"comment",type:"string"},
            {name:"sig",type:"bytes"}], outputs:[] },
  { type:"function", name:"getFeedbackCount", stateMutability:"view",
    inputs:[{name:"agent",type:"address"}], outputs:[{type:"uint256"}] },
  { type:"function", name:"getReviewerNonce", stateMutability:"view",
    inputs:[{name:"reviewer",type:"address"}], outputs:[{type:"uint256"}] },
  { type:"function", name:"DOMAIN_SEPARATOR", stateMutability:"view",
    inputs:[], outputs:[{type:"bytes32"}] },
  // Validation
  { type:"function", name:"isValid", stateMutability:"view",
    inputs:[{name:"agent",type:"address"},{name:"tag",type:"bytes32"}],
    outputs:[{type:"bool"}] },
  // Staking
  { type:"function", name:"stake",              stateMutability:"nonpayable",
    inputs:[{name:"amount",type:"uint256"}], outputs:[] },
  { type:"function", name:"unstake",            stateMutability:"nonpayable",
    inputs:[{name:"amount",type:"uint256"}], outputs:[] },
  { type:"function", name:"stakeOf",            stateMutability:"view",
    inputs:[{name:"agent",type:"address"}], outputs:[{type:"uint256"}] },
  { type:"function", name:"hasSufficientStake", stateMutability:"view",
    inputs:[{name:"agent",type:"address"}], outputs:[{type:"bool"}] },
  // Oracle score
  { type:"function", name:"getDetailedScore", stateMutability:"view",
    inputs:[{name:"agent",type:"address"}],
    outputs:[{name:"oracle",type:"uint8"},{name:"rep",type:"uint8"},
             {name:"val",type:"uint256"},{name:"stake",type:"uint256"}] },
  { type:"function", name:"getScore", stateMutability:"view",
    inputs:[{name:"agent",type:"address"}], outputs:[{type:"uint8"}] },
  // Events (used for getLogs)
  { type:"event", name:"AgentRegistered",
    inputs:[{name:"agent",type:"address",indexed:true},
            {name:"owner",type:"address",indexed:true},
            {name:"metadata",type:"string",indexed:false}] },
];

const CUSD_ABI = [
  { type:"function", name:"balanceOf", stateMutability:"view",
    inputs:[{name:"owner",type:"address"}], outputs:[{type:"uint256"}] },
  { type:"function", name:"approve",   stateMutability:"nonpayable",
    inputs:[{name:"spender",type:"address"},{name:"amount",type:"uint256"}],
    outputs:[{type:"bool"}] },
];

// ── App state ─────────────────────────────────────────────────
const S = {
  walletAddr: null,
  isMiniPay:  false,
  allAgents:  [],
  lastBlock:  0n,
  loading:    false,
  pollTimer:  null,
};

let pub  = null;   // viem publicClient
let viem = null;   // all viem exports

// ═══════════════════════════════════════════════════════════════
// CLIENT INIT
// ═══════════════════════════════════════════════════════════════

async function initClients() {
  viem = await import("https://esm.sh/viem@2.16.0");
  pub  = viem.createPublicClient({
    chain:     celoChain(),
    transport: viem.http(CELO_RPC),
  });
}

function celoChain() {
  return {
    id: CELO_CHAIN_ID,
    name: "Celo",
    nativeCurrency: { name:"CELO", symbol:"CELO", decimals:18 },
    rpcUrls:        { default: { http: [CELO_RPC] } },
    blockExplorers: { default: { name:"Celoscan", url:"https://celoscan.io" } },
  };
}

// helper — read from the one oracle contract
const read = (fn, args = []) =>
  pub.readContract({ address: ADDR.Oracle, abi: ORACLE_ABI, functionName: fn, args });

// ═══════════════════════════════════════════════════════════════
// WALLET / MINIPAY
// ═══════════════════════════════════════════════════════════════

function detectMiniPay() {
  if (window.ethereum?.isMiniPay) {
    S.isMiniPay = true;
    document.querySelector(".chain-badge").textContent = "🔗 MiniPay";
    document.getElementById("connect-btn").style.display = "none";
    autoConnect();
  }
}

async function autoConnect() {
  try {
    const [addr] = await window.ethereum.request({ method: "eth_requestAccounts" });
    if (addr) await onConnected(addr);
  } catch {}
}

async function connectWallet() {
  if (!window.ethereum) { showToast("Open in MiniPay or MetaMask", "error"); return; }
  const btn = document.getElementById("connect-btn");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>';
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0x" + CELO_CHAIN_ID.toString(16) }],
    }).catch(() => {});
    const [addr] = await window.ethereum.request({ method: "eth_requestAccounts" });
    if (addr) await onConnected(addr);
  } catch {
    showToast("Connection rejected", "error");
  } finally {
    btn.disabled  = false;
    btn.textContent = S.walletAddr ? "✓" : "Connect";
  }
}

async function onConnected(addr) {
  S.walletAddr = addr;
  document.getElementById("wallet-dot").classList.add("connected");
  document.getElementById("wallet-addr").textContent = trunc(addr);
  document.getElementById("connect-btn").textContent  = "✓";
  document.getElementById("connect-btn").disabled     = true;
  document.getElementById("reg-agent").value          = addr;

  // cUSD balance
  try {
    const bal = await pub.readContract({
      address: ADDR.cUSD, abi: CUSD_ABI, functionName: "balanceOf", args: [addr],
    });
    document.getElementById("cusd-bal").textContent = fmtCUSD(bal) + " cUSD";
  } catch {}

  showToast("Wallet connected ✓", "success");
  renderMyAgents();
}

// ═══════════════════════════════════════════════════════════════
// SOCIALCONNECT — phone → address
// ═══════════════════════════════════════════════════════════════

async function resolvePhone() {
  const raw = document.getElementById("reg-phone").value.trim();
  if (!raw) return;
  const num = raw.replace(/\D/g, "");
  showToast("Looking up phone…", "success");
  try {
    const res  = await fetch(
      `https://api.socialconnect.celo.org/lookup?phoneNumber=%2B${num}`,
      { headers: { Accept: "application/json" } },
    );
    const json = await res.json();
    if (!json?.address) { showToast("Phone not found on SocialConnect", "error"); return; }
    document.getElementById("reg-agent").value = json.address;
    showToast("Address resolved ✓", "success");
  } catch {
    showToast("SocialConnect lookup failed", "error");
  }
}

// ═══════════════════════════════════════════════════════════════
// SEND TX  (MiniPay: legacy type, feeCurrency = cUSD)
// ═══════════════════════════════════════════════════════════════

async function sendTx(contractAddr, abi, fnName, args) {
  if (!S.walletAddr) throw new Error("not connected");
  const data    = viem.encodeFunctionData({ abi, functionName: fnName, args });
  const txHash  = await window.ethereum.request({
    method: "eth_sendTransaction",
    params: [{
      from:        S.walletAddr,
      to:          contractAddr,
      data,
      value:       "0x0",
      feeCurrency: ADDR.cUSD,   // MiniPay: pay gas in cUSD
      type:        "0x0",       // legacy — EIP-1559 not supported by MiniPay
    }],
  });
  showToast("Tx sent — confirming…", "success");
  const receipt = await pub.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status === "reverted") throw new Error("Transaction reverted");
  return receipt;
}

// helper for oracle contract specifically
const txOracle = (fn, args) => sendTx(ADDR.Oracle, ORACLE_ABI, fn, args);

// ── EIP-712 sign  ─────────────────────────────────────────────
async function signFeedback(agent, score, tagSlug, comment, nonce) {
  const tag = viem.keccak256(viem.toBytes(tagSlug));

  const sig = await window.ethereum.request({
    method: "eth_signTypedData_v4",
    params: [S.walletAddr, JSON.stringify({
      domain: {
        name:              "AgentReputationOracle",
        version:           "1",
        chainId:           CELO_CHAIN_ID,
        verifyingContract: ADDR.Oracle,           // single contract address
      },
      types: {
        Feedback: [
          { name:"agent",   type:"address" },
          { name:"score",   type:"uint8"   },
          { name:"tag",     type:"bytes32" },
          { name:"comment", type:"string"  },
          { name:"nonce",   type:"uint256" },
        ],
      },
      primaryType: "Feedback",
      message: { agent, score, tag, comment, nonce: Number(nonce) },
    })],
  });
  return { sig, tag };
}

// ═══════════════════════════════════════════════════════════════
// ON-CHAIN READS
// ═══════════════════════════════════════════════════════════════

async function fetchAllAgents() {
  // Pull every AgentRegistered event from the oracle contract
  const logs = await pub.getLogs({
    address:   ADDR.Oracle,
    event:     ORACLE_ABI.find(e => e.name === "AgentRegistered"),
    fromBlock: 0n,
    toBlock:   "latest",
  });

  const agents = await Promise.all(logs.map(async log => {
    const addr = log.args.agent;
    try {
      // Three reads from the one contract — no cross-contract calls
      const [detail, feedbackCount, staked] = await Promise.all([
        read("getDetailedScore", [addr]),
        read("getFeedbackCount", [addr]),
        read("hasSufficientStake", [addr]),
      ]);

      const parsed = parseMeta(log.args.metadata || "");
      return {
        address:  addr,
        owner:    log.args.owner,
        name:     parsed.name  || "Agent " + addr.slice(2, 6).toUpperCase(),
        emoji:    parsed.emoji || "🤖",
        score:    Number(detail.oracle ?? detail[0]),
        rep:      Number(detail.rep    ?? detail[1]),
        val:      Number(detail.val    ?? detail[2]),
        stake:    Number(detail.stake  ?? detail[3]),
        staked,
        meta:     log.args.metadata || "",
        feedback: Number(feedbackCount),
        tags:     [],      // resolved lazily in detail view
        blockNum: log.blockNumber,
      };
    } catch { return null; }
  }));

  return agents.filter(Boolean).sort((a, b) => b.score - a.score);
}

async function fetchAgentDetail(addr) {
  // All reads from the single oracle contract
  const [detail, feedbackCount, staked, info] = await Promise.all([
    read("getDetailedScore", [addr]),
    read("getFeedbackCount", [addr]),
    read("hasSufficientStake", [addr]),
    read("getAgent", [addr]),
  ]);

  // Resolve capability tags — one read per tag, all from the same contract
  const activeTags = [];
  for (const [slug] of Object.entries(CAP_TAGS)) {
    const tag   = viem.keccak256(viem.toBytes(slug));
    const valid = await read("isValid", [addr, tag]).catch(() => false);
    if (valid) activeTags.push(slug);
  }

  const parsed = parseMeta(info.metadata ?? info[1] ?? "");
  return {
    address:    addr,
    owner:      info.owner      ?? info[0],
    name:       parsed.name     || "Agent " + addr.slice(2, 6).toUpperCase(),
    emoji:      parsed.emoji    || "🤖",
    score:      Number(detail.oracle ?? detail[0]),
    rep:        Number(detail.rep    ?? detail[1]),
    val:        Number(detail.val    ?? detail[2]),
    stake:      Number(detail.stake  ?? detail[3]),
    staked,
    meta:       info.metadata   ?? info[1] ?? "",
    feedback:   Number(feedbackCount),
    tags:       activeTags,
    registered: Number(info.registered ?? info[2]),
  };
}

function parseMeta(raw) {
  if (!raw) return {};
  if (raw.startsWith("{")) { try { return JSON.parse(raw); } catch {} }
  return {};
}

// ═══════════════════════════════════════════════════════════════
// LIVE POLLING
// ═══════════════════════════════════════════════════════════════

async function loadAgents() {
  if (S.loading) return;
  S.loading = true;
  setStatus("⟳ Refreshing…");
  try {
    S.allAgents = await fetchAllAgents();
    renderAgents(S.allAgents);
    setStatus("● Live · " + new Date().toLocaleTimeString());
  } catch (e) {
    setStatus("⚠ RPC error");
    console.error(e);
  } finally { S.loading = false; }
}

function startPolling() {
  loadAgents();
  S.pollTimer = setInterval(async () => {
    try {
      const block = await pub.getBlockNumber();
      if (block > S.lastBlock) { S.lastBlock = block; await loadAgents(); }
    } catch {}
  }, POLL_MS);
}

function setStatus(txt) {
  const el = document.getElementById("feed-status");
  if (el) el.textContent = txt;
}

// ═══════════════════════════════════════════════════════════════
// TAB ROUTING
// ═══════════════════════════════════════════════════════════════

function switchTab(id, el, mode = "top") {
  document.getElementById("score-result").style.display = "none";
  document.getElementById("agents-feed").style.display  = "block";

  document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
  document.getElementById("panel-" + id).classList.add("active");

  if (mode === "nav") {
    document.querySelectorAll(".nav-item").forEach(b => b.classList.remove("active"));
    el.classList.add("active");
    const map = ["lookup", "submit", "register"];
    document.querySelectorAll(".tab").forEach((t, i) =>
      t.classList.toggle("active", map[i] === id));
  } else {
    document.querySelectorAll(".tab").forEach(b => b.classList.remove("active"));
    el.classList.add("active");
    document.querySelectorAll(".nav-item").forEach(b =>
      b.classList.toggle("active", b.id === "nav-" + id));
  }
}

// ═══════════════════════════════════════════════════════════════
// RENDER: FEED
// ═══════════════════════════════════════════════════════════════

function filterAgents(val) {
  const q = val.toLowerCase();
  renderAgents(q
    ? S.allAgents.filter(a =>
        a.name.toLowerCase().includes(q) || a.address.toLowerCase().includes(q))
    : S.allAgents);
}

function renderAgents(list) {
  const el = document.getElementById("agents-list");
  if (!list.length) {
    el.innerHTML = `<div class="empty-state">
      <div class="empty-icon">${S.loading ? "⟳" : "🔍"}</div>
      <div>${S.loading ? "Loading agents…" : "No agents found"}</div></div>`;
    return;
  }
  el.innerHTML = list.map((a, i) => {
    const sc   = scoreColor(a.score);
    const tags = a.tags.slice(0, 2).map(t =>
      CAP_TAGS[t] ? `<span class="tag-chip valid">${CAP_TAGS[t].emoji} ${CAP_TAGS[t].label}</span>` : ""
    ).join("");
    const medal = ["🥇","🥈","🥉"][i] ?? "";
    return `
    <div class="agent-card" onclick="showAgentDetail('${a.address}')">
      <div class="agent-card-top">
        <div class="agent-avatar">${a.emoji}</div>
        <div class="agent-meta">
          <div class="agent-name">${medal} ${esc(a.name)}</div>
          <div class="agent-addr">${trunc(a.address)}</div>
        </div>
        <div class="score-pill" style="background:${sc.bg};color:${sc.fg}">${a.score}</div>
      </div>
      <div class="agent-card-bottom">
        ${tags}
        <span class="stake-badge ${a.staked ? "active" : "inactive"}">
          ${a.staked ? "✓ Staked" : "○ No Stake"}</span>
        <span class="feedback-count">${a.feedback} reviews</span>
      </div>
    </div>`;
  }).join("");
}

// ═══════════════════════════════════════════════════════════════
// RENDER: DETAIL
// ═══════════════════════════════════════════════════════════════

async function showAgentDetail(addr) {
  document.getElementById("agents-feed").style.display  = "none";
  document.getElementById("score-result").style.display = "block";
  document.getElementById("score-result").innerHTML =
    `<div class="empty-state"><span class="spinner"></span>
     <div style="margin-top:12px">Loading on-chain data…</div></div>`;
  try {
    const a      = await fetchAgentDetail(addr);
    const c      = scoreColor(a.score);
    const offset = 2 * Math.PI * 70 * (1 - a.score / 100);

    const tagChips = Object.entries(CAP_TAGS).map(([slug, info]) =>
      `<span class="tag-chip ${a.tags.includes(slug) ? "valid" : "invalid"}">
         ${info.emoji} ${info.label}</span>`
    ).join("");

    const rows = [
      ["Address",    `<a href="https://celoscan.io/address/${a.address}" target="_blank" style="color:var(--accent)">${trunc(a.address)}</a>`],
      ["Owner",      trunc(a.owner)],
      ["Metadata",   esc((a.meta||"").slice(0, 48) || "—")],
      ["Reviews",    a.feedback],
      ["Staked",     a.staked ? "✓ Yes" : "○ No"],
      ["Registered", a.registered ? new Date(a.registered * 1000).toLocaleDateString() : "—"],
    ].map(([k, v]) => `
      <div class="info-row">
        <span class="info-row-label">${k}</span>
        <span class="info-row-val">${v}</span>
      </div>`).join("");

    document.getElementById("score-result").innerHTML = `
      <button class="back-btn" onclick="backToFeed()">← Back</button>
      <div class="score-ring-wrap">
        <div class="ring-container">
          <svg class="ring-svg" width="160" height="160" viewBox="0 0 160 160">
            <circle class="ring-bg"   cx="80" cy="80" r="70"/>
            <circle class="ring-fill" cx="80" cy="80" r="70"
              style="stroke:${c.fg};stroke-dashoffset:${offset}"/>
          </svg>
          <div class="ring-label">
            <span class="ring-score" style="color:${c.fg}">${a.score}</span>
            <span class="ring-unit">/ 100</span>
          </div>
        </div>
        <div class="score-grade" style="color:${c.fg}">${scoreName(a.score)}</div>
        <div style="font-family:'Syne',sans-serif;font-weight:700;font-size:15px;
                    margin-top:6px">${esc(a.name)}</div>
      </div>
      <div class="breakdown">
        <div class="breakdown-title">Score Breakdown</div>
        <div class="bar-row">
          <div class="bar-header"><span class="bar-label">Reputation (70%)</span>
            <span class="bar-val" style="color:var(--celo)">${a.rep}</span></div>
          <div class="bar-track"><div class="bar-fill" style="width:${a.rep}%;background:var(--celo)"></div></div>
        </div>
        <div class="bar-row">
          <div class="bar-header"><span class="bar-label">Validations (20%)</span>
            <span class="bar-val" style="color:var(--accent)">${a.val}</span></div>
          <div class="bar-track"><div class="bar-fill" style="width:${a.val}%;background:var(--accent)"></div></div>
        </div>
        <div class="bar-row">
          <div class="bar-header"><span class="bar-label">Stake (10%)</span>
            <span class="bar-val" style="color:var(--celo2)">${a.stake}</span></div>
          <div class="bar-track"><div class="bar-fill" style="width:${a.stake}%;background:var(--celo2)"></div></div>
        </div>
      </div>
      <div class="breakdown">
        <div class="breakdown-title">Capability Tags</div>
        <div class="tags-wrap">${tagChips}</div>
      </div>
      <div class="breakdown">
        <div class="breakdown-title">Agent Info</div>${rows}
      </div>
      <button class="btn-primary" style="margin:0 0 20px"
        onclick="prefillAndGoReview('${a.address}')">
        ✍️ Leave a Review
      </button>`;
  } catch (e) {
    document.getElementById("score-result").innerHTML =
      `<button class="back-btn" onclick="backToFeed()">← Back</button>
       <div class="empty-state"><div class="empty-icon">⚠️</div>
       <div>${esc(e.message)}</div></div>`;
  }
}

function prefillAndGoReview(addr) {
  document.getElementById("fb-agent").value = addr;
  switchTab("submit", document.querySelectorAll(".tab")[1]);
}

function backToFeed() {
  document.getElementById("score-result").style.display = "none";
  document.getElementById("agents-feed").style.display  = "block";
}

async function lookupAgent() {
  const addr = document.getElementById("lookup-input").value.trim();
  if (!addr) { showToast("Enter a valid address", "error"); return; }
  const ok = await read("isRegistered", [addr]).catch(() => false);
  if (!ok) { showToast("Agent not registered on-chain", "error"); return; }
  showAgentDetail(addr);
}

// ═══════════════════════════════════════════════════════════════
// SUBMIT FEEDBACK
// ═══════════════════════════════════════════════════════════════

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("fb-score").addEventListener("input", function () {
    document.getElementById("fb-score-display").textContent = this.value;
    updateSliderColor(this);
  });
});

function updateSliderColor(el) {
  const v = parseInt(el.value);
  document.getElementById("fb-score-display").style.color =
    v >= 75 ? "#35d07f" : v >= 50 ? "#fbcc5c" : "#ef4444";
}

async function submitFeedback() {
  if (!S.walletAddr) { showToast("Connect wallet first", "error"); return; }
  const agent   = document.getElementById("fb-agent").value.trim();
  const score   = parseInt(document.getElementById("fb-score").value);
  const tagSlug = document.getElementById("fb-tag").value;
  const comment = document.getElementById("fb-comment").value.trim();
  if (!agent) { showToast("Enter agent address", "error"); return; }

  const btn = document.getElementById("fb-submit-btn");
  btn.disabled = true;
  try {
    btn.innerHTML = '<span class="spinner"></span> Getting nonce…';
    const nonce = await read("getReviewerNonce", [S.walletAddr]);

    btn.textContent = "Awaiting signature…";
    const { sig, tag } = await signFeedback(agent, score, tagSlug, comment, nonce);

    btn.innerHTML = '<span class="spinner"></span> Submitting…';
    await txOracle("submitFeedback", [agent, score, tag, comment, sig]);

    showToast(`Review submitted — ${score}/100 ✓`, "success");
    document.getElementById("fb-comment").value = "";
    await loadAgents();
  } catch (e) {
    showToast(e.message?.slice(0, 60) || "Failed", "error");
  } finally {
    btn.disabled    = false;
    btn.textContent = "Sign & Submit Review";
  }
}

// ═══════════════════════════════════════════════════════════════
// REGISTER AGENT  (3 txs, but only 2 contracts total)
// ═══════════════════════════════════════════════════════════════

async function registerAgent() {
  if (!S.walletAddr) { showToast("Connect wallet first", "error"); return; }

  let agent    = document.getElementById("reg-agent").value.trim();
  const meta   = document.getElementById("reg-meta").value.trim();
  const stakeN = parseFloat(document.getElementById("reg-stake").value || 0);
  const phone  = document.getElementById("reg-phone").value.trim();

  if (phone && !agent) {
    await resolvePhone();
    agent = document.getElementById("reg-agent").value.trim();
    if (!agent) return;
  }

  if (!agent)      { showToast("Enter address or phone", "error"); return; }
  if (!meta)       { showToast("Enter metadata",         "error"); return; }
  if (stakeN < 10) { showToast("Min stake is 10 cUSD",  "error"); return; }

  const stakeWei = BigInt(Math.floor(stakeN * 1e18));
  const btn = document.getElementById("reg-submit-btn");
  btn.disabled = true;

  try {
    // Tx 1: approve cUSD → oracle contract (not a separate vault — same contract)
    btn.innerHTML = '<span class="spinner"></span> Approving cUSD…';
    await sendTx(ADDR.cUSD, CUSD_ABI, "approve", [ADDR.Oracle, stakeWei]);

    // Tx 2: register agent identity in the oracle
    btn.innerHTML = '<span class="spinner"></span> Registering…';
    await txOracle("registerAgent", [agent, meta]);

    // Tx 3: stake cUSD (oracle contract holds the tokens directly)
    btn.innerHTML = `<span class="spinner"></span> Staking ${stakeN} cUSD…`;
    await txOracle("stake", [stakeWei]);

    showToast(`Registered & ${stakeN} cUSD staked ✓`, "success");
    ["reg-meta","reg-stake","reg-phone"].forEach(id =>
      document.getElementById(id).value = "");
    await loadAgents();
    renderMyAgents();
  } catch (e) {
    showToast(e.message?.slice(0, 60) || "Failed", "error");
  } finally {
    btn.disabled    = false;
    btn.textContent = "Register & Stake";
  }
}

function renderMyAgents() {
  if (!S.walletAddr) return;
  const mine = S.allAgents.filter(
    a => a.owner?.toLowerCase() === S.walletAddr.toLowerCase()
  );
  const wrap = document.getElementById("my-agents-list");
  if (!mine.length) {
    wrap.innerHTML = `<div class="empty-state">
      <div class="empty-icon">🤖</div><div>No agents registered yet</div></div>`;
    return;
  }
  wrap.innerHTML = mine.map(a => {
    const c = scoreColor(a.score);
    return `<div class="agent-card" onclick="showAgentDetail('${a.address}')">
      <div class="agent-card-top">
        <div class="agent-avatar">${a.emoji}</div>
        <div class="agent-meta">
          <div class="agent-name">${esc(a.name)}</div>
          <div class="agent-addr">${trunc(a.address)}</div>
        </div>
        <div class="score-pill" style="background:${c.bg};color:${c.fg}">${a.score}</div>
      </div></div>`;
  }).join("");
}

function renderContractAddresses() {
  document.getElementById("contract-rows").innerHTML = `
    <div class="info-row">
      <span class="info-row-label">Oracle (all-in-one)</span>
      <span class="info-row-val" style="font-size:10px">
        <a href="https://celoscan.io/address/${ADDR.Oracle}" target="_blank"
           style="color:var(--accent);text-decoration:none">${trunc(ADDR.Oracle)}</a>
      </span>
    </div>
    <div class="info-row">
      <span class="info-row-label">cUSD</span>
      <span class="info-row-val" style="font-size:10px">
        <a href="https://celoscan.io/address/${ADDR.cUSD}" target="_blank"
           style="color:var(--accent);text-decoration:none">${trunc(ADDR.cUSD)}</a>
      </span>
    </div>`;
}

// ═══════════════════════════════════════════════════════════════
// UTILS
// ═══════════════════════════════════════════════════════════════

const scoreColor = s =>
  s >= 80 ? { bg:"rgba(53,208,127,.15)", fg:"#35d07f" } :
  s >= 60 ? { bg:"rgba(251,204,92,.15)", fg:"#fbcc5c" } :
            { bg:"rgba(239,68,68,.15)",  fg:"#ef4444" };

const scoreName = s =>
  s >= 90 ? "Excellent" : s >= 75 ? "Trusted" :
  s >= 60 ? "Reliable"  : s >= 40 ? "Caution" : "Low Trust";

const trunc   = a  => a ? a.slice(0,6)+"…"+a.slice(-4) : "—";
const fmtCUSD = w  => (Number(w) / 1e18).toFixed(2);
const esc     = s  => String(s ?? "").replace(/[&<>"']/g,
  c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

function showToast(msg, type = "success") {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className   = "show " + type;
  clearTimeout(t._t);
  t._t = setTimeout(() => { t.className = ""; }, 3200);
}

// ═══════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════

window.addEventListener("load", async () => {
  await initClients();
  detectMiniPay();
  renderContractAddresses();
  updateSliderColor(document.getElementById("fb-score"));
  startPolling();
});
