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

    /**
     * How long a restarted server is given before the button returns to idle.
     *
     * Long enough that the launcher has started the replacement and the page has
     * reconnected, so the control is usable again rather than stuck.
     */
    const RESTART_SETTLE_MS = 6000

    const NS = 'easy-exit'

    /**
     * Ask the host to shut down, or to restart.
     *
     * A dropped connection counts as success: the tree disposes as it answers.
     *
     * The restart flag travels in the query string rather than the body. It is a
     * single flag, and the request URL is always readable, whereas a body-borne
     * flag was measured to be ignored by the live web carrier.
     *
     * @param restart - whether to ask the launcher to start the server again.
     * @returns The response, when one arrives before the process leaves.
     */
    async function postShutdown(restart = false) {
      const controller = new AbortController()
      const deadline = setTimeout(() => controller.abort(), TIMEOUT_MS)
      try {
        return await fetch(restart ? `${API_PATH}?restart=1` : API_PATH, {
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
     * One header action button.
     *
     * Two of these share the seat: one asks the launcher to stop the server, one
     * asks it to start the server again. They are separate buttons because the
     * seat API has no menu support and the command surface cannot be opened
     * programmatically from a button, so a single control could not offer a
     * choice.
     *
     * The slot shares no owner props, so the translate function arrives through
     * the register inject factory.
     *
     * @param mode - `'exit'` or `'restart'`, selecting the wording and the request.
     * @param icon - the glyph shown on the button.
     * @returns The registered slot component.
     */
    function makeActionButton(mode, icon) {
      const restart = mode === 'restart'
      const word = key => `${mode}${key}`

      return function ActionButton(props) {
        const tr = props?.tr ?? ((key, fallback) => fallback)
        const [phase, setPhase] = React.useState('idle')
        const [refusal, setRefusal] = React.useState(undefined)
        const timer = React.useRef(undefined)
        const reset = React.useRef(undefined)

        React.useEffect(() => () => {
          if (timer.current !== undefined) clearTimeout(timer.current)
          if (reset.current !== undefined) clearTimeout(reset.current)
        }, [])

        const onClick = React.useCallback(async () => {
          if (phase === 'stopping') return
          if (phase === 'armed' || phase === 'refused') {
            if (timer.current !== undefined) clearTimeout(timer.current)
            setPhase('stopping')
            let reply
            try {
              reply = await postShutdown(restart)
            } catch {
              // A dropped connection means the server is already leaving.
            }
            const answer = await readReply(reply)
            if (answer.accepted) {
              if (restart) {
                // A restart keeps the tab, and this button must become usable
                // again: leaving it in `stopping` left it disabled, dimmed and
                // stuck on "Restarting the server…" after the server was back.
                // The launcher needs a few seconds, so the label says so and the
                // control returns to idle on its own.
                setPhase('restarting')
                reset.current = setTimeout(() => setPhase('idle'), RESTART_SETTLE_MS)
                return
              }
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
        const restarting = phase === 'restarting'
        const busy = armed || stopping || stopped || refused || restarting
        // The seat's own CSS is `flex:none` with no overflow rule, so a long
        // label widens the button until it leaves the header and looks like it
        // vanished. The label therefore stays short; the host's full account of
        // the refusal goes in the tooltip.
        const label = stopped
          ? tr(word('Stopped'), 'The server has stopped. This page can be closed.')
          : refused
            ? tr('refused', 'Still running - click to try again')
            : restarting
              ? tr(word('Restarting'), 'Restarting - the page will reconnect.')
              : stopping
                ? tr(word('Stopping'), restart ? 'Restarting the server…' : 'Stopping the server…')
                : armed
                  ? tr(word('Confirm'), restart ? 'Confirm restart' : 'Confirm exit')
                  : tr(word('Label'), restart ? 'Restart DeepSeek Harness' : 'Exit DeepSeek Harness')
        // The host's account is the useful part and is far too long for the
        // label, so it becomes the hover text.
        const tooltip = refused && refusal?.message ? `${label} - ${refusal.message}` : label

        return h(
          'button',
          {
            type: 'button',
            onClick,
            // Only the stopping hand-off blocks the control. A restart must not:
            // it returns to idle by itself, and greying it out was what made the
            // button look stuck after the server came back.
            disabled: stopping,
            title: tooltip,
            'aria-label': tooltip,
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
              height: '28px',
              // Bounded so a long refusal can never widen the header row.
              maxWidth: '220px',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
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
          h('span', { 'aria-hidden': true, style: { fontSize: '1.05em', lineHeight: 1 } }, icon),
          busy ? h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, label) : null,
        )
      }
    }

    const ExitButton = makeActionButton('exit', '⏻')
    const RestartButton = makeActionButton('restart', '⟳')

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(
          () => ctx.locale.register(NS, 'en', {
            exitLabel: 'Exit DeepSeek Harness',
            exitConfirm: 'Confirm exit',
            exitStopping: 'Stopping the server…',
            exitStopped: 'The server has stopped. This page can be closed.',
            restartLabel: 'Restart DeepSeek Harness',
            restartConfirm: 'Confirm restart',
            restartStopping: 'Restarting the server…',
            restartStopped: 'Restarting - the page will reconnect.',
            restartRestarting: 'Restarting - the page will reconnect.',
            refused: 'Still running - click to try again',
            restartCommandLabel: 'Restart',
            restartCommandDescription: 'Restart the dsh web server',
            restartOptionLabel: 'Restart the dsh web server',
            restartOptionDetail: 'Stops the process and lets the launcher start it again.',
            restartGateTitle: 'Restart dsh web?',
            restartGateBody: 'Every open tab and session loses the server for a moment.',
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
            exitLabel: '退出 DeepSeek Harness',
            exitConfirm: '确认退出',
            exitStopping: '正在停止服务…',
            exitStopped: '服务已停止，可以关闭此页面了。',
            restartLabel: '重启 DeepSeek Harness',
            restartConfirm: '确认重启',
            restartStopping: '正在重启服务…',
            restartStopped: '正在重启，页面会自动重连。',
            restartRestarting: '正在重启，页面会自动重连。',
            refused: '仍有任务在运行，点此重试',
            restartCommandLabel: '重启',
            restartCommandDescription: '重启 dsh web 服务',
            restartOptionLabel: '重启 dsh web 服务',
            restartOptionDetail: '停掉进程，由启动脚本重新拉起。',
            restartGateTitle: '确定重启 dsh web？',
            restartGateBody: '所有标签页与会话会短暂失去服务。',
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

        ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register(
          {
            name: 'conversation.session.header.utilities',
            id: 'easy-restart',
            order: 91,
            inject: () => ({ tr }),
          },
          RestartButton,
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

            ctx.effect(() => commandUi.register({
              name: 'restart',
              label: () => tr('restartCommandLabel', 'Restart'),
              description: () => tr('restartCommandDescription', 'Restart the dsh web server'),
              available: () => true,
              ui: {
                kind: 'popupSelect',
                options: async () => [{
                  id: 'restart',
                  label: tr('restartOptionLabel', 'Restart the dsh web server'),
                  detail: tr('restartOptionDetail', 'Stops the process and lets the launcher start it again.'),
                  confirmation: {
                    title: tr('restartGateTitle', 'Restart dsh web?'),
                    description: tr('restartGateBody', 'Every open tab and session loses the server for a moment.'),
                  },
                }],
                onSelect: async () => {
                  // No tab close: the launcher brings the server back and the
                  // page reconnects by itself.
                  try {
                    await postShutdown(true)
                  } catch {
                    // Expected when the process leaves mid-response.
                  }
                },
              },
            }), 'easy-exit: /restart command')
          }
        } catch {
          // The command surface is optional; the header button still works.
        }
      },
    }
  },
})
