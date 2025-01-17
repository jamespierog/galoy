import { intraledgerPaymentSendWalletId } from "@app/wallets"
import { getRewardsConfig, onboardingEarn } from "@config"
import {
  InvalidIPMetadataForRewardError,
  InvalidPhoneMetadataForRewardError,
  InvalidQuizQuestionIdError,
} from "@domain/errors"
import { IPMetadataValidator } from "@domain/users-ips/ip-metadata-validator"
import { PhoneMetadataValidator } from "@domain/users/phone-metadata-validator"
import { getFunderWalletId } from "@services/ledger/caching"
import {
  RewardsRepository,
  WalletsRepository,
  AccountsRepository,
  UsersRepository,
} from "@services/mongoose"
import { UsersIpRepository } from "@services/mongoose/users-ips"

const rewardsConfig = getRewardsConfig()

export const addEarn = async ({
  quizQuestionId,
  accountId,
  logger,
}: {
  quizQuestionId: QuizQuestionId
  accountId: AccountId /* AccountId: aid validation */
  logger: Logger
}): Promise<QuizQuestion | ApplicationError> => {
  const amount = onboardingEarn[quizQuestionId]
  if (!amount) return new InvalidQuizQuestionIdError()

  const funderWalletId = await getFunderWalletId()
  const funderWallet = await WalletsRepository().findById(funderWalletId)
  if (funderWallet instanceof Error) return funderWallet
  const funderAccount = await AccountsRepository().findById(funderWallet.accountId)
  if (funderAccount instanceof Error) return funderAccount

  const recipientAccount = await AccountsRepository().findById(accountId)
  if (recipientAccount instanceof Error) return recipientAccount

  const user = await UsersRepository().findById(recipientAccount.ownerId)
  if (user instanceof Error) return user

  const validatedPhoneMetadata = PhoneMetadataValidator(rewardsConfig).validateForReward(
    user.phoneMetadata,
  )
  if (validatedPhoneMetadata instanceof Error)
    return new InvalidPhoneMetadataForRewardError(validatedPhoneMetadata.name)

  const userIps = await UsersIpRepository().findById(recipientAccount.ownerId)
  if (userIps instanceof Error) return userIps

  const lastIPs = userIps.lastIPs
  const lastIp = lastIPs.length > 0 ? lastIPs[lastIPs.length - 1] : undefined
  const validatedIPMetadata = IPMetadataValidator(rewardsConfig).validateForReward(lastIp)
  if (validatedIPMetadata instanceof Error)
    return new InvalidIPMetadataForRewardError(validatedIPMetadata.name)

  const recipientWalletId = recipientAccount.defaultWalletId

  const shouldGiveReward = await RewardsRepository(accountId).add(quizQuestionId)
  if (shouldGiveReward instanceof Error) return shouldGiveReward

  const payment = await intraledgerPaymentSendWalletId({
    senderWalletId: funderWalletId,
    recipientWalletId,
    amount,
    memo: quizQuestionId,
    logger,
    senderAccount: funderAccount,
  })
  if (payment instanceof Error) return payment

  return { id: quizQuestionId, earnAmount: amount }
}
