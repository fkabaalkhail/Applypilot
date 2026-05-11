import React, { useRef } from 'react'
import { motion, useInView, Variants } from 'framer-motion'

type AnimationType = 'fadeUp' | 'fadeDown' | 'fadeLeft' | 'fadeRight' | 'scale' | 'blur'

interface AnimatedSectionProps {
  children: React.ReactNode
  className?: string
  animation?: AnimationType
  delay?: number
  duration?: number
  once?: boolean
  amount?: number
  stagger?: boolean
}

const animations: Record<AnimationType, Variants> = {
  fadeUp: {
    hidden: { opacity: 0, y: 60 },
    visible: { opacity: 1, y: 0 },
  },
  fadeDown: {
    hidden: { opacity: 0, y: -60 },
    visible: { opacity: 1, y: 0 },
  },
  fadeLeft: {
    hidden: { opacity: 0, x: -60 },
    visible: { opacity: 1, x: 0 },
  },
  fadeRight: {
    hidden: { opacity: 0, x: 60 },
    visible: { opacity: 1, x: 0 },
  },
  scale: {
    hidden: { opacity: 0, scale: 0.8 },
    visible: { opacity: 1, scale: 1 },
  },
  blur: {
    hidden: { opacity: 0, filter: 'blur(10px)' },
    visible: { opacity: 1, filter: 'blur(0px)' },
  },
}

const AnimatedSection: React.FC<AnimatedSectionProps> = ({
  children,
  className = '',
  animation = 'fadeUp',
  delay = 0,
  duration = 0.7,
  once = true,
  amount = 0.2,
}) => {
  const ref = useRef<HTMLDivElement>(null)
  const isInView = useInView(ref, { once, amount })

  return (
    <motion.div
      ref={ref}
      className={className}
      variants={animations[animation]}
      initial="hidden"
      animate={isInView ? 'visible' : 'hidden'}
      transition={{
        duration,
        delay,
        ease: [0.16, 1, 0.3, 1],
      }}
    >
      {children}
    </motion.div>
  )
}

/** Container that staggers its children's animations */
export const StaggerContainer: React.FC<{
  children: React.ReactNode
  className?: string
  staggerDelay?: number
  once?: boolean
  amount?: number
}> = ({ children, className = '', staggerDelay = 0.1, once = true, amount = 0.2 }) => {
  const ref = useRef<HTMLDivElement>(null)
  const isInView = useInView(ref, { once, amount })

  return (
    <motion.div
      ref={ref}
      className={className}
      initial="hidden"
      animate={isInView ? 'visible' : 'hidden'}
      variants={{
        hidden: {},
        visible: {
          transition: {
            staggerChildren: staggerDelay,
          },
        },
      }}
    >
      {children}
    </motion.div>
  )
}

/** Individual stagger item — must be inside StaggerContainer */
export const StaggerItem: React.FC<{
  children: React.ReactNode
  className?: string
  animation?: AnimationType
  duration?: number
}> = ({ children, className = '', animation = 'fadeUp', duration = 0.6 }) => {
  return (
    <motion.div
      className={className}
      variants={animations[animation]}
      transition={{ duration, ease: [0.16, 1, 0.3, 1] }}
    >
      {children}
    </motion.div>
  )
}

/** Floating animation for decorative elements */
export const FloatingElement: React.FC<{
  children?: React.ReactNode
  className?: string
  duration?: number
  distance?: number
}> = ({ children, className = '', duration = 3, distance = 10 }) => {
  return (
    <motion.div
      className={className}
      animate={{ y: [-distance, distance, -distance] }}
      transition={{
        duration,
        repeat: Infinity,
        ease: 'easeInOut',
      }}
    >
      {children}
    </motion.div>
  )
}

/** Counter animation for stats */
export const AnimatedCounter: React.FC<{
  value: number
  suffix?: string
  prefix?: string
  className?: string
  duration?: number
}> = ({ value, suffix = '', prefix = '', className = '', duration = 2 }) => {
  const ref = useRef<HTMLSpanElement>(null)
  const isInView = useInView(ref, { once: true, amount: 0.5 })
  const [count, setCount] = React.useState(0)

  React.useEffect(() => {
    if (!isInView) return

    let startTime: number
    const animate = (timestamp: number) => {
      if (!startTime) startTime = timestamp
      const progress = Math.min((timestamp - startTime) / (duration * 1000), 1)
      const eased = 1 - Math.pow(1 - progress, 3) // easeOutCubic
      setCount(Math.floor(eased * value))

      if (progress < 1) {
        requestAnimationFrame(animate)
      }
    }

    requestAnimationFrame(animate)
  }, [isInView, value, duration])

  return (
    <span ref={ref} className={className}>
      {prefix}{count}{suffix}
    </span>
  )
}

export default AnimatedSection
