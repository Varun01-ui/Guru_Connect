import { Queue, Worker } from 'bullmq'
import { createQueueConnection, getRedis } from './redis.js'

// One repeating BullMQ job (00-conventions §10). Needs Redis: without it the job simply isn't scheduled, which is
// safe for the maintenance jobs here (they only prune data that every query already ignores).
export async function scheduleRepeatingJob(input: {
  queueName: string
  schedulerId: string
  pattern: string
  tz?: string
  handler: () => Promise<void>
}): Promise<(() => Promise<void>) | null> {
  if (!(await getRedis())) {
    console.warn(`[jobs] Redis unavailable - ${input.queueName} not scheduled`)
    return null
  }

  const queue = new Queue(input.queueName, { connection: createQueueConnection() })
  const worker = new Worker(input.queueName, async () => input.handler(), { connection: createQueueConnection() })
  queue.on('error', (err) => console.error(`[jobs] ${input.queueName} queue error:`, err.message))
  worker.on('error', (err) => console.error(`[jobs] ${input.queueName} worker error:`, err.message))
  await queue.upsertJobScheduler(input.schedulerId, { pattern: input.pattern, tz: input.tz }, { name: input.schedulerId })
  console.log(`[jobs] ${input.queueName} scheduled (${input.pattern}${input.tz ? ` ${input.tz}` : ''})`)

  return async () => {
    await worker.close()
    await queue.close()
  }
}
