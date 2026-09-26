/**
 * Client half of dsh-easy-exit.
 *
 * Loaded by the shell as a classic script and registered through the lazy-CJS
 * module table, so this file is a factory body: no `import`/`export`, and
 * `require` resolves only against the shell's frozen module table (React and
 * friends). The factory returns the Cordis plugin object the shell applies.
 *
 * Two affordances share one shutdown path:
 *
 *  - a power button in the conversation header's utilities seat — visible on
 *    every session, with no sidebar expansion and no dependence on the right
 *    sidebar;
 *  - an `/exit` slash command, which opens the shared popup's own risk gate.
 *
 * Both require a second, deliberate confirmation: the exit is process-wide and
 * stops the server for every open tab and every session.
 */

window.__ModuleLoader__.load({
  id: 'dsh-easy-exit',
  factory(require) {
    const React = require('react')

    const h = React.createElement

    /** Matches the host half's route. */
    const API_PATH = '/easy-exit/api'

    /** How long the armed button stays armed before it resets. */
    const CONFIRM_WINDOW_MS = 5000

    /** How long to wait for the host's answer before assuming it stopped. */
    const TIMEOUT_MS = 8000

    const NS = 'easy-exit'

    /**
     * Ask the host to shut down.
     *
     * A dropped connection counts as success: the tree disposes as it answers.
     *
     * @returns The response, when one arrives before the process leaves.
     */
    async function postShutdown() {
      const controller = new AbortController()
      const deadline = setTimeout(() => controller.abort(), TIMEOUT_MS)
      try {
        return await fetch(API_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
          signal: controller.signal,
        })
      } finally {
        clearTimeout(deadline)
      }
    }

    /**
     * What the host said about the shutdown request.
     *
     * A dropped connection counts as acceptance: the tree disposes as it
     * answers, so there may be no reply at all. An answered refusal does NOT —
     * that is the running-job guard, and treating it as acceptance closed the
     * tab for a server that was still running.
     *
     * @param response - the reply, or undefined when the request failed.
     * @returns `{ accepted }` plus the host's account of a refusal.
     */
    async function readReply(response) {
      if (response === undefined) return { accepted: true }
      try {
        const payload = await response.json()
        return { accepted: payload?.ok === true, message: payload?.message, jobs: payload?.jobs }
      } catch {
        return { accepted: false }
      }
    }

    /**
     * Try to close the tab this button is on.
     *
     * Browsers only honour `window.close()` for a window the script opened
     * itself; for a tab opened by the user or by a shell, it is silently
     * ignored — no return value, no exception. So the button also switches to a
     * "this page can be closed" label: when the close works the reader never has
     * time to read it, and when it is refused that label is the whole point.
     */
    function tryCloseTab() {
      try {
        window.close()
      } catch {
        // Refused by policy; the label on screen covers it.
      }
    }

    /**
     * The header button.
     *
     * The slot shares no owner props, so the translate function arrives through
     * the register inject factory.
     *
     * @param props - injected `tr` only.
     */
    function ExitButton(props) {
      const tr = props?.tr ?? ((key, fallback) => fallback)
      const [phase, setPhase] = React.useState('idle')
      const [refusal, setRefusal] = React.useState(undefined)
      const timer = React.useRef(undefined)

      React.useEffect(() => () => {
        if (timer.current !== undefined) clearTimeout(timer.current)
      }, [])

      const onClick = React.useCallback(async () => {
        if (phase === 'stopping') return
        if (phase === 'armed' || phase === 'refused') {
          if (timer.current !== undefined) clearTimeout(timer.current)
          setPhase('stopping')
          let reply
          try {
            reply = await postShutdown()
          } catch {
            // A dropped connection means the server is already leaving.
          }
          const answer = await readReply(reply)
          if (answer.accepted) {
            // Set before asking to close: the label is only ever read when the
            // browser refuses to close the tab.
            setPhase('stopped')
            // Closing from the click that asked for the shutdown keeps this a
            // user-initiated act, which some browsers require.
            tryCloseTab()
            return
          }
          // Refused - most likely jobs are still running. Keep the tab: the
          // server is alive and its reply explains what is holding it up.
          setRefusal(answer)
          setPhase('refused')
          return
        }
        setPhase('armed')
        timer.current = setTimeout(() => setPhase('idle'), CONFIRM_WINDOW_MS)
      }, [phase])

      const armed = phase === 'armed'
      const stopping = phase === 'stopping'
      const stopped = phase === 'stopped'
      const refused = phase === 'refused'
      const busy = armed || stopping || stopped || refused
      const label = stopped
        ? tr('stopped', 'The server has stopped. This page can be closed.')
        : refused
          ? (refusal ?? tr('refused', 'Jobs are still running. Click to try again.'))
          : stopping
            ? tr('stopping', 'Stopping the server…')
            : armed
              ? tr('confirmShort', 'Confirm exit')
              : tr('exit', 'Exit DeepSeek Harness')

      return h(
        'button',
        {
          type: 'button',
          onClick,
          disabled: stopping,
          title: label,
          'aria-label': label,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
            height: '28px',
            padding: busy ? '0 8px' : '0 6px',
            border: armed || refused ? '1px solid var(--dsw-alias-border-danger, #d9534f)' : '1px solid transparent',
            borderRadius: '6px',
            background: 'transparent',
            color: armed || refused ? 'var(--dsw-alias-text-danger, #d9534f)' : 'inherit',
            opacity: stopping || stopped ? 0.6 : 1,
            cursor: stopping ? 'default' : 'pointer',
            font: 'inherit',
            fontSize: '0.8125em',
            whiteSpace: 'nowrap',
          },
        },
        h('span', { 'aria-hidden': true, style: { fontSize: '1.05em', lineHeight: 1 } }, '⏻'),
        busy ? h('span', null, label) : null,
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(
          () => ctx.locale.register(NS, 'en', {
            exit: 'Exit DeepSeek Harness',
            confirmShort: 'Confirm exit',
            stopping: 'Stopping the server…',
            stopped: 'The server has stopped. This page can be closed.',
            refused: 'Jobs are still running. Stopping would kill that work - wait, then click to try again.',
            commandLabel: 'Exit',
            commandDescription: 'Shut down the dsh web server',
            optionLabel: 'Shut down the dsh web server',
            optionDetail: 'Stops the server process. Sessions and stored state are preserved.',
            gateTitle: 'Shut down dsh web?',
            gateBody: 'Every open tab and session loses the server. Sessions and stored state are preserved; restart with the desktop launcher.',
          }),
          'easy-exit: en dictionary',
        )
        ctx.effect(
          () => ctx.locale.register(NS, 'zh', {
            exit: '退出 DeepSeek Harness',
            confirmShort: '确认退出',
            stopping: '正在停止服务…',
            stopped: '服务已停止，可以关闭此页面了。',
            refused: '仍有任务在运行，退出会中断它们。请等它跑完，再点一次重试。',
            commandLabel: '退出',
            commandDescription: '关闭 dsh web 服务',
            optionLabel: '关闭 dsh web 服务',
            optionDetail: '会停止服务进程。会话与已保存的状态都会保留。',
            gateTitle: '确定关闭 dsh web？',
            gateBody: '所有已打开的标签页与会话都会断开。会话和已保存的状态会保留，用桌面启动脚本可重新启动。',
          }),
          'easy-exit: zh dictionary',
        )

        // Bound once: the translate function reads the live dictionary, so a
        // language switch reaches the next render without re-registering.
        const tr = (key, fallback) => {
          try {
            const text = ctx.locale.bind(NS)(key)
            return text === key ? fallback : text
          } catch {
            return fallback
          }
        }

        ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register(
          {
            name: 'conversation.session.header.utilities',
            id: 'easy-exit',
            order: 90,
            inject: () => ({ tr }),
          },
          ExitButton,
        ))

        // Optional second seat: a slash command that opens the shared popup's
        // own risk gate rather than exiting on a bare invocation.
        try {
          const commandUi = ctx.get('commandUi')
          if (commandUi !== undefined && typeof commandUi.register === 'function') {
            ctx.effect(() => commandUi.register({
              name: 'exit',
              label: () => tr('commandLabel', 'Exit'),
              description: () => tr('commandDescription', 'Shut down the dsh web server'),
              available: () => true,
              ui: {
                kind: 'popupSelect',
                options: async () => [{
                  id: 'shutdown',
                  label: tr('optionLabel', 'Shut down the dsh web server'),
                  detail: tr('optionDetail', 'Stops the server process.'),
                  confirmation: {
                    title: tr('gateTitle', 'Shut down dsh web?'),
                    description: tr('gateBody', 'Every open tab and session loses the server.'),
                  },
                }],
                onSelect: async () => {
                  let reply
                  try {
                    reply = await postShutdown()
                  } catch {
                    // A dropped connection means the server is already leaving.
                  }
                  // Same decision as the button: only a server that accepted
                  // the shutdown gets its tab closed.
                  if ((await readReply(reply)).accepted) tryCloseTab()
                },
              },
            }), 'easy-exit: /exit command')
          }
        } catch {
          // The command surface is optional; the header button still works.
        }
      },
    }
  },
})
