import React, { useState, useEffect, useRef } from 'react'
import { motion, useInView } from 'framer-motion'

interface TypewriterTextProps {
  /** The text to type out */
  text: string
  /** Typing speed in ms per character */
  speed?: number
  /** CSS class for the text */
  className?: string
  /** Delay before typing starts (ms) */
  delay?: number
  /** Whether to show blinking cursor */
  showCursor?: boolean
  /** Whether to trigger on scroll into view */
  triggerOnView?: boolean
  /** Callback when typing completes */
  onComplete?: () => void
  /** Whether to loop the animation */
  loop?: boolean
  /** Pause duration between loops (ms) */
  loopPause?: number
}

/**
 * Inline typewriter text component for use in headings, paragraphs, etc.
 * Renders as a <span> so it can be placed inside any text element.
 */
const TypewriterText: React.FC<TypewriterTextProps> = ({
  text,
  speed = 80,
  className = '',
  delay = 0,
  showCursor = true,
  triggerOnView = false,
  onComplete,
  loop = false,
  loopPause = 2000,
}) => {
  const [displayText, setDisplayText] = useState('')
  const [isTyping, setIsTyping] = useState(false)
  const [hasStarted, setHasStarted] = useState(!triggerOnView)
  const ref = useRef<HTMLSpanElement>(null)
  const isInView = useInView(ref, { once: !loop, amount: 0.5 })

  useEffect(() => {
    if (triggerOnView && isInView) {
      setHasStarted(true)
    }
  }, [isInView, triggerOnView])

  useEffect(() => {
    if (!hasStarted) return

    let currentIndex = 0
    let intervalId: ReturnType<typeof setInterval>
    let timeoutId: ReturnType<typeof setTimeout>
    let loopTimeoutId: ReturnType<typeof setTimeout>

    const startTyping = () => {
      setIsTyping(true)
      currentIndex = 0
      setDisplayText('')

      intervalId = setInterval(() => {
        if (currentIndex <= text.length) {
          setDisplayText(text.slice(0, currentIndex))
          currentIndex++
        } else {
          clearInterval(intervalId)
          setIsTyping(false)
          onComplete?.()

          if (loop) {
            loopTimeoutId = setTimeout(() => {
              startTyping()
            }, loopPause)
          }
        }
      }, speed)
    }

    timeoutId = setTimeout(startTyping, delay)

    return () => {
      clearInterval(intervalId)
      clearTimeout(timeoutId)
      clearTimeout(loopTimeoutId)
    }
  }, [hasStarted, text, speed, delay, loop, loopPause])

  return (
    <motion.span
      ref={ref}
      className={className}
      initial={{ opacity: 0 }}
      animate={{ opacity: hasStarted ? 1 : 0 }}
      transition={{ duration: 0.3 }}
      style={{ display: 'inline' }}
    >
      {displayText}
      {showCursor && (
        <motion.span
          animate={{ opacity: isTyping ? 1 : [1, 0] }}
          transition={isTyping ? {} : { duration: 0.5, repeat: Infinity, repeatType: 'reverse' }}
          style={{ marginLeft: '1px', fontWeight: 300 }}
          aria-hidden="true"
        >
          |
        </motion.span>
      )}
    </motion.span>
  )
}

export default TypewriterText
