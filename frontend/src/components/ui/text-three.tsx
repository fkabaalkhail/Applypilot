import React, { useState, useEffect } from 'react'
import { motion } from 'framer-motion'

interface TextThreeProps {
  text?: string
  speed?: number
  className?: string
  as?: 'h1' | 'h2' | 'h3' | 'p' | 'span' | 'div'
  delay?: number
  onComplete?: () => void
}

const TextThree: React.FC<TextThreeProps> = ({
  text = "Namaste World!",
  speed = 100,
  className = "text-4xl font-semibold",
  delay = 0,
  onComplete,
}) => {
  const [displayText, setDisplayText] = useState("")

  useEffect(() => {
    let currentIndex = 0
    let timeoutId: ReturnType<typeof setTimeout>

    const startTyping = () => {
      const intervalId = setInterval(() => {
        if (currentIndex <= text.length) {
          setDisplayText(text.slice(0, currentIndex))
          currentIndex++
        } else {
          clearInterval(intervalId)
          onComplete?.()
        }
      }, speed)

      return intervalId
    }

    if (delay > 0) {
      timeoutId = setTimeout(() => {
        startTyping()
      }, delay)
    } else {
      const intervalId = startTyping()
      return () => clearInterval(intervalId)
    }

    return () => {
      if (timeoutId) clearTimeout(timeoutId)
    }
  }, [text, speed, delay])

  return (
    <div className="flex justify-center items-center h-64 p-4">
      <motion.div
        className={className}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.5 }}
      >
        {displayText}
        <motion.span
          animate={{ opacity: [1, 0] }}
          transition={{ duration: 0.5, repeat: Infinity, repeatType: "reverse" }}
          style={{ marginLeft: '2px' }}
        >
          |
        </motion.span>
      </motion.div>
    </div>
  )
}

export default TextThree
