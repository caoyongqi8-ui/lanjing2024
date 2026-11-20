import { useCallback, useEffect, useRef, useState } from 'react'
import { SpeechRecognition } from '@capacitor-community/speech-recognition'
import { showToast } from '../base/toastState.js'

export type VoiceInputStatus = 'idle' | 'recording' | 'transcribing'

/** 使用安卓系统自带的语音识别（本地/免费），替代云端 ASR。 */
export const useVoiceInput = (onText: (text: string) => void) => {
  const [status, setStatus] = useState<VoiceInputStatus>('idle')
  /** 本次录音已录秒数，只在录音中递增 */
  const [seconds, setSeconds] = useState(0)
  const partialRef = useRef('')
  const operationRef = useRef(0)
  const onTextRef = useRef(onText)
  onTextRef.current = onText

  const cancelOperation = useCallback(async () => {
    operationRef.current++
    try {
      await SpeechRecognition.stop()
    } catch {
      // 未在聆听时忽略
    }
    partialRef.current = ''
  }, [])

  const cancel = useCallback(() => {
    void cancelOperation()
    setStatus('idle')
  }, [cancelOperation])

  const finish = useCallback(async () => {
    const operation = operationRef.current
    setStatus('transcribing')
    try {
      await SpeechRecognition.stop()
    } catch {
      // 忽略停止错误
    }
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
  }, [])

  const toggle = useCallback(async () => {
    if (status === 'recording') {
      await finish()
      return
    }
    if (status === 'transcribing') {
      cancel()
      return
    }
    const operation = ++operationRef.current
    partialRef.current = ''
    setStatus('recording')
    try {
      // 请求权限（安卓 RECORD_AUDIO）
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
  }, [status, finish, cancel])

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

  return { status, seconds, getAnalyser, toggle, cancel, available: true }
}
