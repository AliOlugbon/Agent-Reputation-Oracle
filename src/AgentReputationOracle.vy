# @version ^0.4.0
# @title   AgentReputationOracle
# @notice  ERC-8004 AI Agent Reputation Oracle for Celo / MiniPay.
# @license MIT
# @author  Ali Malik - aliolugbon@gmail.com

# ─────────────────────────────────────────────────────────────────────────────
# INTERFACES
# ─────────────────────────────────────────────────────────────────────────────

interface IERC20:
    def transferFrom(sender: address, recipient: address, amount: uint256) -> bool: nonpayable
    def transfer(recipient: address, amount: uint256) -> bool: nonpayable

# ─────────────────────────────────────────────────────────────────────────────
# STRUCTS
# ─────────────────────────────────────────────────────────────────────────────

struct AgentInfo:
    owner:      address
    metadata:   String[256]   # JSON {"name":"…","emoji":"🤖"} or ipfs://Qm…
    registered: uint256       # block.timestamp
    active:     bool

struct FeedbackEntry:
    reviewer:   address
    score:      uint8         # 0-100
    tag:        bytes32       # keccak256(capability slug)
    comment:    String[512]
    timestamp:  uint256
    nonce:      uint256

struct ValidationRecord:
    validator:  address
    validFrom:  uint256
    validUntil: uint256       # 0 = no expiry
    active:     bool

# ─────────────────────────────────────────────────────────────────────────────
# EVENTS  
# ─────────────────────────────────────────────────────────────────────────────

event AgentRegistered:
    agent:    indexed(address)
    owner:    indexed(address)
    metadata: String[256]

event AgentDeactivated:
    agent: indexed(address)

event FeedbackSubmitted:
    agent:    indexed(address)
    reviewer: indexed(address)
    score:    uint8
    tag:      indexed(bytes32)

event ValidationGranted:
    agent:      indexed(address)
    tag:        indexed(bytes32)
    validUntil: uint256

event ValidationRevoked:
    agent: indexed(address)
    tag:   indexed(bytes32)

event Staked:
    agent:  indexed(address)
    amount: uint256

event Unstaked:
    agent:  indexed(address)
    amount: uint256

event Slashed:
    agent:  indexed(address)
    amount: uint256

# ─────────────────────────────────────────────────────────────────────────────
# CONSTANTS
# ─────────────────────────────────────────────────────────────────────────────

# EIP-712
DOMAIN_TYPEHASH: constant(bytes32) = keccak256(
    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
)
FEEDBACK_TYPEHASH: constant(bytes32) = keccak256(
    "Feedback(address agent,uint8 score,bytes32 tag,string comment,uint256 nonce)"
)

# Score weights  (must sum to 100)
W_REP:   constant(uint256) = 70   # reputation ledger weight
W_VAL:   constant(uint256) = 20   # validation bonus weight
W_STAKE: constant(uint256) = 10   # staking bonus weight

# Per-validated-tag bonus (raw, out of 100)
BONUS_PER_TAG: constant(uint256) = 10

# Staking
MIN_STAKE:     constant(uint256) = 10 * 10**18   # 10 cUSD
SLASH_PCT:     constant(uint256) = 20            # slash 20 % of stake
SLASH_SCORE:   constant(uint8)   = 10            # slash 10 rep points

# Storage caps
MAX_FEEDBACK: constant(uint256) = 500
MAX_TAGS:     constant(uint256) = 10  # max tracked capability tags

# ─────────────────────────────────────────────────────────────────────────────
# STATE
# ─────────────────────────────────────────────────────────────────────────────

admin:     public(address)
cUSD:      public(address)

# ── Identity ──────────────────────────────────────────────────
agents: public(HashMap[address, AgentInfo])

# ── Reputation ────────────────────────────────────────────────
scoreSum:     HashMap[address, uint256]   # cumulative score numerator
scoreCount:   HashMap[address, uint256]   # number of feedback entries
feedbackList: HashMap[address, DynArray[FeedbackEntry, MAX_FEEDBACK]]
nonces:       public(HashMap[address, uint256])  # reviewer → nonce

# ── Validation ────────────────────────────────────────────────
validations: HashMap[address, HashMap[bytes32, ValidationRecord]]
validators:  public(HashMap[address, bool])

# Tracked capability tags (for val bonus calculation)
capTags:     public(DynArray[bytes32, MAX_TAGS])

# ── Staking ───────────────────────────────────────────────────
stakes:    public(HashMap[address, uint256])
slashers:  public(HashMap[address, bool])

# ── EIP-712 ───────────────────────────────────────────────────
DOMAIN_SEPARATOR: public(bytes32)

# ─────────────────────────────────────────────────────────────────────────────
# CONSTRUCTOR
# ─────────────────────────────────────────────────────────────────────────────

@deploy
def __init__(cusd_token: address):
    """
    @param cusd_token  cUSD address on Celo mainnet:
                       0x765DE816845861e75A25fCA122bb6898B8B1282a
    """
    self.admin = msg.sender
    self.cUSD  = cusd_token

    # Admin is a default validator
    self.validators[msg.sender] = True

    # EIP-712 domain separator — must match app.js signFeedback() exactly
    self.DOMAIN_SEPARATOR = keccak256(
        abi_encode(
            DOMAIN_TYPEHASH,
            keccak256(convert("AgentReputationOracle", Bytes[64])),
            keccak256(convert("1", Bytes[4])),
            chain.id,
            self,
        )
    )

    # Seed the five canonical capability tags
    self._addTag(keccak256(convert("defi_trading", Bytes[32])))
    self._addTag(keccak256(convert("nft_valuation", Bytes[32])))
    self._addTag(keccak256(convert("governance", Bytes[32])))
    self._addTag(keccak256(convert("bridge", Bytes[32])))
    self._addTag(keccak256(convert("prediction", Bytes[32])))

# ─────────────────────────────────────────────────────────────────────────────
# IDENTITY — registerAgent / isRegistered / getAgent
# ─────────────────────────────────────────────────────────────────────────────

@external
def registerAgent(agent: address, metadata: String[256]):
    """
    @notice Register an AI agent. Caller becomes the owner.
    """
    assert agent != empty(address), "zero address"
    assert not self.agents[agent].active, "already registered"
    assert len(metadata) > 0, "empty metadata"

    self.agents[agent] = AgentInfo(
        owner      = msg.sender,
        metadata   = metadata,
        registered = block.timestamp,
        active     = True,
    )
    log AgentRegistered(agent=agent, owner=msg.sender, metadata=metadata)

@view
@external
def isRegistered(agent: address) -> bool:
    return self.agents[agent].active

@view
@external
def getAgent(agent: address) -> AgentInfo:
    return self.agents[agent]

@external
def updateMetadata(agent: address, metadata: String[256]):
    assert self.agents[agent].active, "not registered"
    assert self.agents[agent].owner == msg.sender, "not owner"
    self.agents[agent].metadata = metadata

@external
def deactivateAgent(agent: address):
    assert self.agents[agent].active, "not active"
    assert self.agents[agent].owner == msg.sender or msg.sender == self.admin, "unauthorised"
    self.agents[agent].active = False
    log AgentDeactivated(agent=agent)

# ─────────────────────────────────────────────────────────────────────────────
# REPUTATION — submitFeedback / getFeedbackCount / getReviewerNonce
# ─────────────────────────────────────────────────────────────────────────────

@external
def submitFeedback(
    agent:   address,
    score:   uint8,
    tag:     bytes32,
    comment: String[512],
    sig:     Bytes[65],
):
    """
    @notice Submit EIP-712-signed feedback for a registered agent.
    @param  sig  65-byte signature: r (32) | s (32) | v (1)
    """
    assert score <= 100, "score > 100"
    assert self.agents[agent].active, "agent not registered"
    assert len(self.feedbackList[agent]) < MAX_FEEDBACK, "feedback cap"
    assert len(sig) == 65, "Invalid signature length"

    # ── EIP-712 verification ────────────────────────────────────────────────
    nonce: uint256 = self.nonces[msg.sender]

    struct_hash: bytes32 = keccak256(
        abi_encode(
            FEEDBACK_TYPEHASH,
            agent,
            score,
            tag,
            keccak256(convert(comment, Bytes[512])),
            nonce,
        )
    )
    digest: bytes32 = keccak256(
        concat(b"\x19\x01", self.DOMAIN_SEPARATOR, struct_hash)
    )

    r: bytes32 = convert(slice(sig, 0,  32), bytes32)
    s: bytes32 = convert(slice(sig, 32, 32), bytes32)
    v: uint8   = convert(slice(sig, 64, 1), uint8)
    signer: address = ecrecover(digest, v, r, s)
    assert signer == msg.sender, "invalid signature"

    # ── Record ──────────────────────────────────────────────────────────────
    self.nonces[msg.sender] = nonce + 1
    self.scoreSum[agent] += convert(score, uint256)
    self.scoreCount[agent] += 1

    self.feedbackList[agent].append(
        FeedbackEntry(
            reviewer  = msg.sender,
            score     = score,
            tag       = tag,
            comment   = comment,
            timestamp = block.timestamp,
            nonce     = nonce,
        )
    )
    log FeedbackSubmitted(agent=agent, reviewer=msg.sender, score=score, tag=tag)

@view
@external
def getReputation(agent: address) -> uint8:
    """Average feedback score for agent (0-100)."""
    count: uint256 = self.scoreCount[agent]
    if count == 0:
        return 0
    return convert(min(self.scoreSum[agent] // count, 100), uint8)

@view
@external
def getFeedbackCount(agent: address) -> uint256:
    return len(self.feedbackList[agent])

@view
@external
def getFeedback(agent: address, index: uint256) -> FeedbackEntry:
    assert index < len(self.feedbackList[agent]), "out of range"
    return self.feedbackList[agent][index]

@view
@external
def getReviewerNonce(reviewer: address) -> uint256:
    return self.nonces[reviewer]

# ─────────────────────────────────────────────────────────────────────────────
# VALIDATION — isValid / validate / revokeValidation
# ─────────────────────────────────────────────────────────────────────────────

@view
@external
def isValid(agent: address, tag: bytes32) -> bool:
    rec: ValidationRecord = self.validations[agent][tag]
    if not rec.active:
        return False
    if rec.validUntil != 0 and rec.validUntil <= block.timestamp:
        return False
    return True

@external
def validate(agent: address, tag: bytes32, validUntil: uint256):
    """Grant a capability tag to an agent. Only validators may call."""
    assert self.validators[msg.sender], "not a validator"
    assert self.agents[agent].active, "agent not registered"
    assert validUntil == 0 or validUntil > block.timestamp, "already expired"

    self.validations[agent][tag] = ValidationRecord(
        validator  = msg.sender,
        validFrom  = block.timestamp,
        validUntil = validUntil,
        active     = True,
    )
    log ValidationGranted(agent=agent, tag=tag, validUntil=validUntil)

@external
def revokeValidation(agent: address, tag: bytes32):
    rec: ValidationRecord = self.validations[agent][tag]
    assert rec.active, "not active"
    assert rec.validator == msg.sender or msg.sender == self.admin, "unauthorised"
    self.validations[agent][tag].active = False
    log ValidationRevoked(agent=agent, tag=tag)

# ─────────────────────────────────────────────────────────────────────────────
# STAKING — stake / unstake / stakeOf / hasSufficientStake
# ─────────────────────────────────────────────────────────────────────────────

@external
def stake(amount: uint256):
    assert self.agents[msg.sender].active, "not registered"
    assert amount >= MIN_STAKE, "below minimum (10 cUSD)"

    assert extcall IERC20(self.cUSD).transferFrom(msg.sender, self, amount), "cUSD transfer failed"
    self.stakes[msg.sender] += amount
    log Staked(agent=msg.sender, amount=amount)

@external
def unstake(amount: uint256):
    """Withdraw part or all of your stake."""
    assert self.stakes[msg.sender] >= amount, "insufficient stake"
    remaining: uint256 = self.stakes[msg.sender] - amount
    assert remaining == 0 or remaining >= MIN_STAKE, "would breach min stake"

    self.stakes[msg.sender] = remaining
    assert extcall IERC20(self.cUSD).transfer(msg.sender, amount), "transfer failed"
    log Unstaked(agent=msg.sender, amount=amount)

@view
@external
def stakeOf(agent: address) -> uint256:
    return self.stakes[agent]

@view
@external
def hasSufficientStake(agent: address) -> bool:
    return self.stakes[agent] >= MIN_STAKE

# ─────────────────────────────────────────────────────────────────────────────
# ORACLE — getDetailedScore / getScore
# ─────────────────────────────────────────────────────────────────────────────

@view
@external
def getDetailedScore(agent: address) -> (uint8, uint8, uint256, uint256):
    """
    @notice Returns (oracleScore, repScore, valBonus, stakeBonus).
    """
    if not self.agents[agent].active:
        return (0, 0, 0, 0)

    rep:   uint8   = self._avgRep(agent)
    val:   uint256 = self._valBonus(agent)
    stake: uint256 = self._stakeBonus(agent)

    raw: uint256 = (
        convert(rep, uint256) * W_REP + val * W_VAL + stake * W_STAKE
    ) // 100

    return (convert(min(raw, 100), uint8), rep, val, stake)

@view
@external
def getScore(agent: address) -> uint8:
    if not self.agents[agent].active:
        return 0
    rep:   uint8   = self._avgRep(agent)
    val:   uint256 = self._valBonus(agent)
    stake: uint256 = self._stakeBonus(agent)
    raw: uint256 = (
        convert(rep, uint256) * W_REP + val * W_VAL + stake * W_STAKE
    ) // 100
    return convert(min(raw, 100), uint8)

# ─────────────────────────────────────────────────────────────────────────────
# INTERNAL HELPERS
# ─────────────────────────────────────────────────────────────────────────────

@view
@internal
def _avgRep(agent: address) -> uint8:
    count: uint256 = self.scoreCount[agent]
    if count == 0:
        return 0
    return convert(min(self.scoreSum[agent] // count, 100), uint8)

@view
@internal
def _valBonus(agent: address) -> uint256:
    """
    Count how many tracked capability tags the agent holds.
    Each tag contributes BONUS_PER_TAG points (raw out of 100).
    """
    count: uint256 = 0
    for tag: bytes32 in self.capTags:
        rec: ValidationRecord = self.validations[agent][tag]
        if rec.active:
            if rec.validUntil == 0 or rec.validUntil > block.timestamp:
                count += 1
    return min(count * BONUS_PER_TAG, 100)

@view
@internal
def _stakeBonus(agent: address) -> uint256:
    if self.stakes[agent] >= MIN_STAKE:
        return 100
    return 0

@internal
def _addTag(tag: bytes32):
    """Register a capability tag for bonus tracking. Internal only."""
    if len(self.capTags) < MAX_TAGS:
        self.capTags.append(tag)

# ─────────────────────────────────────────────────────────────────────────────
# ADMIN
# ─────────────────────────────────────────────────────────────────────────────

@external
def addValidator(validator: address):
    assert msg.sender == self.admin, "not admin"
    self.validators[validator] = True

@external
def removeValidator(validator: address):
    assert msg.sender == self.admin, "not admin"
    self.validators[validator] = False

@external
def addCapabilityTag(tag: bytes32):
    """Add a new capability tag to the oracle's tracking list."""
    assert msg.sender == self.admin, "not admin"
    assert len(self.capTags) < MAX_TAGS, "tag limit"
    self.capTags.append(tag)

@external
def slash(agent: address, reason: String[128]):
    """
    Slash 20 % of an agent's cUSD stake and subtract SLASH_SCORE
    from their reputation. Only authorised slashers may call.
    """
    assert self.slashers[msg.sender] or msg.sender == self.admin, "not slasher"
    assert self.stakes[agent] > 0, "no stake"

    amount: uint256 = (self.stakes[agent] * SLASH_PCT) // 100
    self.stakes[agent] -= amount

    # Reduce scoreSum (never below zero)
    penalty: uint256 = convert(SLASH_SCORE, uint256)
    if self.scoreSum[agent] >= penalty:
        self.scoreSum[agent] -= penalty
    else:
        self.scoreSum[agent] = 0

    assert extcall IERC20(self.cUSD).transfer(self.admin, amount), "transfer failed"
    log Slashed(agent=agent, amount=amount)

@external
def authoriseSlasher(slasher: address, allowed: bool):
    assert msg.sender == self.admin, "not admin"
    self.slashers[slasher] = allowed

@external
def transferAdmin(new_admin: address):
    assert msg.sender == self.admin, "not admin"
    assert new_admin != empty(address), "zero address"
    self.admin = new_admin

@external
def withdrawCUSD(amount: uint256):
    """Emergency admin withdrawal of any un-staked cUSD in the contract."""
    assert msg.sender == self.admin, "not admin"
    assert extcall IERC20(self.cUSD).transfer(self.admin, amount), "transfer failed"
