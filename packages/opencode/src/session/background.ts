import { Bus } from "@/bus"
import { Session } from "./index"
import { SessionStatus } from "./status"
import { Instance } from "@/project/instance"
import { Log } from "@/util/log"
import { Identifier } from "@/id/id"
import { SessionPrompt } from "./prompt"

export namespace SessionBackground {
  const log = Log.create({ service: "session.background" })

  const state = Instance.state(
    () => {
      const pending = new Map<string, Session.BackgroundTask[]>()
      return { pending, initialized: false }
    },
    async (current) => {
      current.pending.clear()
      current.initialized = false
    },
  )

  export function init() {
    if (state().initialized) {
      return
    }
    state().initialized = true

    Bus.subscribe(Session.Event.BackgroundTaskCompleted, (event) => {
      const sessionID = event.properties.sessionID
      const task = event.properties.task
      const pending = state().pending
      const tasks = pending.get(sessionID) ?? []

      tasks.push(task)
      pending.set(sessionID, tasks)

      const status = SessionStatus.get(sessionID)
      if (status.type !== "idle") {
        return
      }

      flushQueue(sessionID).catch((err) => {
        log.error("failed to process background tasks", { sessionID, error: err })
      })
    })

    Bus.subscribe(SessionStatus.Event.Status, (event) => {
      if (event.properties.status.type !== "idle") {
        return
      }

      const sessionID = event.properties.sessionID

      flushQueue(sessionID).catch((err) => {
        log.error("failed to process background tasks", { sessionID, error: err })
      })
    })
  }

  async function flushQueue(sessionID: string) {
    const s = state()
    const tasks = s.pending.get(sessionID)
    if (!tasks || tasks.length === 0) {
      return
    }

    s.pending.set(sessionID, [])

    for (const task of tasks) {
      const msgID = Identifier.ascending("message")

      await Session.updateMessage({
        id: msgID,
        sessionID,
        role: "user",
        time: { created: Date.now() },
        agent: task.agent,
        model: task.model,
      })

      const output = [`Session ID: ${task.sessionID}`, "", "<task_result>", task.result, "</task_result>"].join("\n")
      const text =
        task.status === "success"
          ? `Background task '${task.description}' completed.\n${output}`
          : `Background task '${task.description}' failed: ${task.result}`

      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: msgID,
        sessionID,
        type: "text",
        synthetic: true,
        text,
      })
    }

    await SessionPrompt.loop({ sessionID })
  }
}
