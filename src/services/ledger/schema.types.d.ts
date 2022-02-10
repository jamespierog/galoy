interface TransactionRecord {
  _id: ObjectId
  _journal: ObjectId
  _original_journal: ObjectId
  id: string
  hash?: string
  txid?: string
  type: string
  pending: boolean
  err?: string
  currency: string
  fee: number
  feeKnownInAdvance?: boolean
  related_journal: string
  payee_addresses?: string[]
  memoPayer?: string
  usd: number
  sats?: number
  feeUsd: number
  username?: string
  pubkey?: string
  credit: number
  debit: number
  datetime: Date
  account_path: string[]
  accounts: string
  book: string
  memo: string
  timestamp: Date
  voided: boolean
  void_reason?: string
  approved: boolean
}

interface TransactionMetadataRecord {
  _id: ObjectId

  hash?: string
  revealedPreImage?: string
}
