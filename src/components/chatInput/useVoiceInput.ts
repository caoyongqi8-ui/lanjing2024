import { useCallback, useEffect, useRef, useState } from 'react'
import { SpeechRecognition } from '@capacitor-community/speech-recognition'
import { showToast } from '../base/toastState.js'

export type VoiceInputStatus = 'idle' | 'recording' | 'transcribing'

/** 使用安卓系统自带的语音识别（本地/免费），按住说话、松手识别。 */
export const useVoiceInput = (onText: (text: string) => void) => {
  const [status, setStatus] = useState<VoiceInputStatus>('idle')
  const [seconds, setSeconds] = useState(0)
  const partialRef = useRef('')
  const operationRef = useRef(0)
  const onTextRef = useRef(onText)
  onTextRef.current = onText

  const cancelOperation = useCallback(async () => {
    operationRef.current++
    partialRef.current = ''
    try {
      await SpeechRecognition.stop()
    } catch {
      // 未在聆听时忽略
    }
  }, [])

  const cancel = useCallback(() => {
    void cancelOperation()
    setStatus('idle')
  }, [cancelOperation])

  /** 按住：开始识别（先确保上次已停止，避免状态错乱导致失败） */
  const start = useCallback(async () => {
    if (status === 'recording') {
      return
    }
    const operation = ++operationRef.current
    partialRef.current = ''
    // 先停掉可能残留的会话，再重新开始
    try {
      await SpeechRecognition.stop()
    } catch {
      // 忽略
    }
    setStatus('recording')
    try {
      await SpeechRecognition.requestPermissions()
      const { available } = await SpeechRecognition.available()
      if (!available) {
        throw new Error('speech recognition unavailable')
      }
      await SpeechRecognition.start({
        language: 'zh-CN',
        maxResults: 1,
        partialResults: true,
        popup: false,
      })
    } catch {
      if (operationRef.current === operation) {
        setStatus('idle')
        showToast({ key: 'voiceInputFailed' })
      }
    }
  }, [status])

  /** 松开：停止识别，把识别结果填入输入框 */
  const finish = useCallback(async () => {
    if (status !== 'recording') {
      return
    }
    const operation = operationRef.current
    setStatus('transcribing')
    try {
      await SpeechRecognition.stop()
    } catch {
      // 忽略停止错误
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
    if (operationRef.current !== operation) {
      return
    }
    const text = partialRef.current.trim()
    partialRef.current = ''
    setStatus('idle')
    if (text) {
      onTextRef.current(text)
    } else {
      showToast({ key: 'voiceInputEmpty' })
    }
  }, [status])

  // 监听实时识别结果
  useEffect(() => {
    let handle: { remove: () => void } | null = null
    SpeechRecognition.addListener('partialResults', (data) => {
      if (data.matches && data.matches.length > 0) {
        partialRef.current = data.matches[0]
      }
    }).then((h) => {
      handle = { remove: () => void h.remove() }
    })
    return () => {
      handle?.remove()
    }
  }, [])

  // 录音时长计数
  useEffect(() => {
    if (status !== 'recording') {
      return
    }
    const startedAt = Date.now()
    setSeconds(0)
    const timer = setInterval(() => {
      setSeconds(Math.floor((Date.now() - startedAt) / 1000))
    }, 500)
    return () => clearInterval(timer)
  }, [status])

  useEffect(() => {
    return () => {
      void cancelOperation()
    }
  }, [cancelOperation])

  const getAnalyser = useCallback(() => null, [])

  return { status, seconds, getAnalyser, start, finish, cancel, available: true }
}
