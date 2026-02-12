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
      const staged = new Map<string, Session.BackgroundTask[]>()
      return { staged, initialized: false }
    },
    async (current) => {
      current.staged.clear()
      current.initialized = false
    },
  )

  export function init() {
    if (state().initialized) {
      return
    }
    state().initialized = true

    Bus.subscribe(Session.Event.BackgroundTaskCompleted, async (event) => {
      const sessionID = event.properties.sessionID
      const task = event.properties.task

      await stageTask(sessionID, task).catch((err) => {
        log.error("failed to stage background task", { sessionID, error: err })
      })
      await wake(sessionID).catch((err) => {
        log.error("failed to wake for staged tasks", { sessionID, error: err })
      })
    })

    Bus.subscribe(SessionStatus.Event.Status, async (event) => {
      const sessionID = event.properties.sessionID

      await wake(sessionID).catch((err) => {
        log.error("failed to wake for staged tasks", { sessionID, error: err })
      })
    })
  }

  async function wake(sessionID: string) {
    const session = await Session.get(sessionID).catch(() => {
      log.warn("session not found, skipping wake", { sessionID })
      return undefined
    })
    if (!session) {
      return
    }

    const s = state()
    const tasks = s.staged.get(sessionID)
    if (!tasks || tasks.length === 0) {
      return
    }

    const status = SessionStatus.get(sessionID)
    if (status.type !== "idle") {
      return
    }

    s.staged.delete(sessionID)
    SessionStatus.set(sessionID, { type: "busy" })
    await SessionPrompt.loop({ sessionID })
  }

  async function stageTask(sessionID: string, task: Session.BackgroundTask) {
    await updateTaskMessage(sessionID, task)

    const staged = state().staged
    const tasks = staged.get(sessionID) ?? []
    staged.set(sessionID, tasks)
    tasks.push(task)
  }

  async function updateTaskMessage(sessionID: string, task: Session.BackgroundTask) {
    const msgID = Identifier.ascending("message")
    const output = [`Session ID: ${task.sessionID}`, "", "<task_result>", task.result, "</task_result>"].join("\n")
    const text =
      task.status === "success"
        ? `Background task '${task.description}' completed.\n${output}`
        : `Background task '${task.description}' failed: ${task.result}`

    await Session.updateMessage({
      id: msgID,
      sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: task.agent,
      model: task.model,
    })
    await Session.updatePart({
      id: Identifier.ascending("part"),
      messageID: msgID,
      sessionID,
      type: "text",
      synthetic: true,
      text,
    })
  }
}
