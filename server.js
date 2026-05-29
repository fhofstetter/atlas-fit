#!/usr/bin/env node

import express from 'express'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectDefaultMetrics } from 'prom-client'

collectDefaultMetrics({ prefix: 'atlas_fit_' })

const __dirname  = path.dirname(fileURLToPath(import.meta.url))
const PORT       = process.env.PORT      ? parseInt(process.env.PORT, 10) : 3457
const HEALTH_DIR = process.env.HEALTH_DIR ?? path.join(__dirname, '../../data/health')
const ATLAS_URL  = process.env.ATLAS_URL  ?? 'http://localhost:3456'

// Preload shared exercise library (synced by tools/scripts/sync-exercises.js)
let _exerciseLibrary = null
async function getExerciseLibrary(planFallback = []) {
  if (!_exerciseLibrary) {
    const data = await readJSON(path.join(HEALTH_DIR, 'exercise-library.json'))
    _exerciseLibrary = data?.exercises ?? null
  }
  return _exerciseLibrary ?? planFallback
}

const app = express()
app.set('views', path.join(__dirname, 'views'))
app.set('view engine', 'ejs')
app.use(express.static(path.join(__dirname, 'public')))
app.use(express.json())

// ── Helpers ───────────────────────────────────────────────────────────────────

async function readJSON(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf-8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

// ── Training constants ────────────────────────────────────────────────────────

const SESSION_TYPE_COLORS = {
  push:  { hex: '#3b82f6', dim: 'rgba(59,130,246,0.15)', border: 'rgba(59,130,246,0.35)', label: 'Push' },
  pull:  { hex: '#8b5cf6', dim: 'rgba(139,92,246,0.15)',  border: 'rgba(139,92,246,0.35)',  label: 'Pull' },
  lower: { hex: '#10b981', dim: 'rgba(16,185,129,0.15)', border: 'rgba(16,185,129,0.35)', label: 'Lower+Core' },
  rest:  { hex: '#4b5563', dim: 'rgba(75,85,99,0.15)',   border: 'rgba(75,85,99,0.35)',   label: 'Rest' },
}

const SESSION_DOW_MAP = {
  1: { 1: 0, 3: 1, 5: 2 },
  2: { 1: 0, 2: 1, 4: 2, 5: 3 },
  3: { 1: 0, 2: 1, 3: 4, 4: 2, 5: 3, 0: 4 },
}

function getSessionType(session) {
  if (!session) return 'rest'
  const label = (session.day_label || '').toLowerCase()
  if (label.includes('push')) return 'push'
  if (label.includes('pull')) return 'pull'
  if (label.includes('lower') || label.includes('core')) return 'lower'
  return 'rest'
}

async function buildWeeklyProgress(workouts, plan) {
  const now    = new Date()
  const dow    = now.getDay()
  const monday = new Date(now)
  monday.setDate(now.getDate() - (dow === 0 ? 6 : dow - 1))
  monday.setHours(0, 0, 0, 0)
  const sunday = new Date(monday)
  sunday.setDate(monday.getDate() + 6)
  sunday.setHours(23, 59, 59, 999)

  const currentPhaseNum = plan.current_phase || 1
  const currentWeek     = plan.current_week  || 1
  const currentPhase    = (plan.phases || []).find(p => p.phase === currentPhaseNum)
  const exerciseLib     = await getExerciseLibrary(plan.exercise_library || [])

  const phaseSchedule = {
    1: [{ day: 'Mon', dow: 1 }, { day: 'Wed', dow: 3 }, { day: 'Fri', dow: 5 }],
    2: [{ day: 'Mon', dow: 1 }, { day: 'Tue', dow: 2 }, { day: 'Thu', dow: 4 }, { day: 'Fri', dow: 5 }],
    3: [{ day: 'Mon', dow: 1 }, { day: 'Tue', dow: 2 }, { day: 'Wed', dow: 3 }, { day: 'Thu', dow: 4 }, { day: 'Fri', dow: 5 }],
  }
  const scheduledDays = phaseSchedule[currentPhaseNum] || phaseSchedule[1]

  const weekWorkouts = workouts.filter(w => {
    if (!w.date) return false
    const d = new Date(w.date)
    return d >= monday && d <= sunday
  })

  const doneDows  = new Set(weekWorkouts.map(w => new Date(w.date).getDay()))
  const dayPills  = scheduledDays.map(s => ({ day: s.day, done: doneDows.has(s.dow) }))
  const normalise = name => name.replace(/\s*\([^)]*\)\s*$/, '').trim().toLowerCase()

  const muscleHits = {}
  weekWorkouts.forEach(workout => {
    ;(workout.exercises || []).forEach(ex => {
      const lib = exerciseLib.find(e =>
        e.name.toLowerCase() === normalise(ex.name || '') ||
        normalise(e.name) === normalise(ex.name || ''))
      ;(lib?.muscles || []).forEach(m => {
        const k = m.toLowerCase()
        muscleHits[k] = (muscleHits[k] || 0) + 1
      })
    })
  })

  const planMuscles = {}
  if (currentPhase) {
    ;(currentPhase.sessions_per_week || []).forEach(session => {
      ;(session.exercises || []).forEach(ex => {
        const lib = exerciseLib.find(e =>
          e.name.toLowerCase() === normalise(ex.name || '') ||
          normalise(e.name) === normalise(ex.name || ''))
        ;(lib?.muscles || []).forEach(m => {
          const k = m.toLowerCase()
          planMuscles[k] = (planMuscles[k] || 0) + 1
        })
      })
    })
  }

  let streak = 0
  const todayMidnight = new Date(); todayMidnight.setHours(0, 0, 0, 0)
  const workoutDateSet = new Set(workouts.map(w => w.date).filter(Boolean))
  for (let i = 0; i < 60; i++) {
    const d = new Date(todayMidnight)
    d.setDate(todayMidnight.getDate() - i)
    if (workoutDateSet.has(d.toISOString().split('T')[0])) {
      streak++
    } else if (i > 0) {
      break
    }
  }

  const planKeys         = Object.keys(planMuscles)
  const workedKeys       = planKeys.filter(m => muscleHits[m])
  const coveragePct      = planKeys.length > 0 ? Math.round((workedKeys.length / planKeys.length) * 100) : 0
  const phaseWeeks       = 4
  const phaseProgressPct = Math.min(100, Math.round(((currentWeek - 1) / phaseWeeks) * 100))

  return {
    dayPills, weekSessionsDone: weekWorkouts.length, weekSessionsPlanned: scheduledDays.length,
    streak, muscleHits, planMuscles, coveragePct, phaseProgressPct, currentWeek, phaseWeeks,
  }
}

function generateTrainingEvents(plan, weeksAhead = 12) {
  if (!plan?.start_date || !plan?.phases) return []
  const events          = []
  const currentPhaseNum = plan.current_phase || 1
  const currentWeek     = plan.current_week  || 1
  const currentPhase    = plan.phases.find(p => p.phase === currentPhaseNum)
  if (!currentPhase) return events

  const sessions   = currentPhase.sessions_per_week || []
  const sessionMap = SESSION_DOW_MAP[currentPhaseNum] || SESSION_DOW_MAP[1]
  const weekStart  = new Date(plan.start_date + 'T00:00:00')
  weekStart.setDate(weekStart.getDate() + (currentWeek - 1) * 7)

  for (let w = 0; w < weeksAhead; w++) {
    for (let d = 0; d < 7; d++) {
      const date = new Date(weekStart)
      date.setDate(weekStart.getDate() + w * 7 + d)
      const dow = date.getDay()
      const idx = sessionMap[dow]
      if (idx === undefined) continue
      const session = sessions[idx]
      if (!session) continue

      const dateStr    = date.toISOString().slice(0, 10)
      const shortLabel = session.day_label.replace(/\s*\(.*?\)\s*/, '').trim()
      const exList     = (session.exercises || []).slice(0, 4).map(e => e.name).join(' · ')
      const sType      = getSessionType(session)
      const sColor     = SESSION_TYPE_COLORS[sType] || SESSION_TYPE_COLORS.rest

      events.push({
        id: `training-${dateStr}-${idx}`,
        title: `🏋 ${shortLabel} — ${exList}`,
        start: dateStr,
        allDay: true,
        url: `${ATLAS_URL}/training`,
        backgroundColor: sColor.hex,
        borderColor: sColor.hex,
        textColor: '#fff',
        extendedProps: {
          category: 'training',
          location: null,
          phase: currentPhaseNum,
          week: currentWeek + w,
          focus: session.focus,
          description: exList,
          cardio: session.cardio ? session.cardio.type : null,
        },
      })
    }
  }
  return events
}

function buildTrainingWeekStrip(plan) {
  if (!plan?.start_date || !plan?.phases) return null
  const currentPhaseNum = plan.current_phase || 1
  const currentWeek     = plan.current_week  || 1
  const currentPhase    = plan.phases.find(p => p.phase === currentPhaseNum)
  if (!currentPhase) return null

  const sessions   = currentPhase.sessions_per_week || []
  const sessionMap = SESSION_DOW_MAP[currentPhaseNum] || SESSION_DOW_MAP[1]
  const weekStart  = new Date(plan.start_date + 'T00:00:00')
  weekStart.setDate(weekStart.getDate() + (currentWeek - 1) * 7)
  const today = new Date().toISOString().slice(0, 10)

  const days = []
  for (let i = 0; i < 7; i++) {
    const d   = new Date(weekStart)
    d.setDate(weekStart.getDate() + i)
    const dow = d.getDay()
    const idx = sessionMap[dow]
    const session = idx !== undefined ? sessions[idx] : null
    const dateStr = d.toISOString().slice(0, 10)
    days.push({
      date: dateStr,
      dayName: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dow],
      dayNum: d.getDate(),
      monthName: ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()],
      session: session ? (() => {
        const sType  = getSessionType(session)
        const sColor = SESSION_TYPE_COLORS[sType] || SESSION_TYPE_COLORS.rest
        return {
          label: session.day_label.replace(/\s*\(.*?\)\s*/, '').trim(),
          focus: session.focus,
          cardio: session.cardio ? session.cardio.type : null,
          color: sColor.hex, colorDim: sColor.dim, colorBorder: sColor.border,
          anchorId: `session-${sType}`,
        }
      })() : null,
      isToday: dateStr === today,
    })
  }

  const weekEnd = new Date(weekStart)
  weekEnd.setDate(weekStart.getDate() + 6)
  return {
    weekNum: currentWeek, phaseNum: currentPhaseNum,
    weekStartDate: weekStart.toISOString().slice(0, 10),
    weekEndDate: weekEnd.toISOString().slice(0, 10),
    days,
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/training', async (_req, res) => {
  const [planData, goalsData, fitnessData] = await Promise.all([
    readJSON(path.join(HEALTH_DIR, 'training-plan.json')),
    readJSON(path.join(HEALTH_DIR, 'health-goals.json')),
    readJSON(path.join(HEALTH_DIR, 'fitness-log.json')),
  ])

  const plan            = planData || {}
  const phases          = plan.phases || []
  const currentPhaseNum = plan.current_phase || 1
  const currentWeek     = plan.current_week  || 1
  const currentPhase    = phases.find(p => p.phase === currentPhaseNum) || null
  const sessions        = currentPhase?.sessions_per_week || []

  const dow      = new Date().getDay()
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  const todayName = dayNames[dow]

  const sessionIndexByPhaseDay = {
    1: { 1: 0, 3: 1, 5: 2 },
    2: { 1: 0, 2: 1, 4: 2, 5: 3 },
    3: { 1: 0, 2: 1, 3: 4, 4: 2, 5: 3, 0: 4 },
  }
  const idx          = (sessionIndexByPhaseDay[currentPhaseNum] || {})[dow]
  const todaySession = idx !== undefined ? (sessions[idx] || null) : null
  const isRestDay    = todaySession === null

  let nextSession    = null
  let nextSessionDay = null
  for (let i = 1; i <= 7; i++) {
    const nextDow = (dow + i) % 7
    const nextIdx = (sessionIndexByPhaseDay[currentPhaseNum] || {})[nextDow]
    if (nextIdx !== undefined && sessions[nextIdx]) {
      nextSession    = sessions[nextIdx]
      nextSessionDay = dayNames[nextDow]
      break
    }
  }

  const militaryGoal = (goalsData?.goals || []).find(g => g.id === 'military-readiness') || null
  const healthGoals  = goalsData?.goals || []

  const startDate    = plan.start_date || null
  const msPerWeek    = 7 * 24 * 60 * 60 * 1000
  const weeksSinceStart = startDate
    ? Math.max(0, Math.floor((Date.now() - new Date(startDate).getTime()) / msPerWeek))
    : 0
  const benchmarkWeeks      = [4, 8, 12]
  const nextBenchmark       = benchmarkWeeks.find(w => w > currentWeek) || null
  const weeksToNextBenchmark = nextBenchmark ? nextBenchmark - currentWeek : 0

  const workouts        = fitnessData?.workouts || []
  const weeklyProgress  = await buildWeeklyProgress(workouts, plan)
  const sessionType     = getSessionType(todaySession)
  const sessionTypeColors = SESSION_TYPE_COLORS[sessionType] || SESSION_TYPE_COLORS.rest
  const nextSessionType   = nextSession ? getSessionType(nextSession) : null
  const nextSessionColors = nextSessionType ? (SESSION_TYPE_COLORS[nextSessionType] || SESSION_TYPE_COLORS.rest) : null

  res.render('training', {
    title: 'Training', activeNav: 'training', atlasUrl: ATLAS_URL,
    plan, phases, currentPhaseNum, currentWeek, currentPhase, sessions,
    todaySession, isRestDay, todayName, sessionTypeColors, nextSessionColors,
    militaryGoal, healthGoals, weeksSinceStart, nextBenchmark, weeksToNextBenchmark,
    workoutCount: workouts.length, recentWorkouts: workouts.slice(-5).reverse(),
    startDate, exerciseLibrary: plan.exercise_library || [],
    weeklyProgress, trainingWeekStrip: buildTrainingWeekStrip(plan),
    nextSession, nextSessionDay,
  })
})

app.get('/health', async (_req, res) => {
  const [sleepData, fitnessData, goalsData] = await Promise.all([
    readJSON(path.join(HEALTH_DIR, 'sleep-log.json')),
    readJSON(path.join(HEALTH_DIR, 'fitness-log.json')),
    readJSON(path.join(HEALTH_DIR, 'health-goals.json')),
  ])

  const sleepEntries   = (sleepData?.entries    || []).slice(-30)
  const fitnessEntries = (fitnessData?.workouts || []).slice(-30)
  const healthGoals    = goalsData?.goals || []
  const avgSleep       = sleepEntries.length
    ? sleepEntries.reduce((sum, e) => sum + (e.duration_hours || 0), 0) / sleepEntries.length
    : null

  res.render('health', {
    title: 'Health', activeNav: 'health', atlasUrl: ATLAS_URL,
    sleepEntries, fitnessEntries, healthGoals, avgSleep,
  })
})

// Redirect root to training
app.get('/', (_req, res) => res.redirect('/training'))

// ── API ───────────────────────────────────────────────────────────────────────

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'atlas-fit', port: PORT })
})

app.get('/api/widget/summary', async (_req, res) => {
  try {
    const [planData, fitnessData] = await Promise.all([
      readJSON(path.join(HEALTH_DIR, 'training-plan.json')),
      readJSON(path.join(HEALTH_DIR, 'fitness-log.json')),
    ])

    const plan     = planData || {}
    const workouts = fitnessData?.workouts || []
    const progress = buildWeeklyProgress(workouts, plan)

    const dow      = new Date().getDay()
    const phases   = plan.phases || []
    const currentPhaseNum = plan.current_phase || 1
    const currentWeek     = plan.current_week  || 1
    const currentPhase    = phases.find(p => p.phase === currentPhaseNum) || null
    const sessions        = currentPhase?.sessions_per_week || []
    const sessionIndexByPhaseDay = {
      1: { 1: 0, 3: 1, 5: 2 },
      2: { 1: 0, 2: 1, 4: 2, 5: 3 },
      3: { 1: 0, 2: 1, 3: 4, 4: 2, 5: 3, 0: 4 },
    }
    const idx          = (sessionIndexByPhaseDay[currentPhaseNum] || {})[dow]
    const todaySession = idx !== undefined ? (sessions[idx] || null) : null

    const todayLabel = todaySession
      ? todaySession.day_label.replace(/\s*\(.*?\)\s*/, '').trim()
      : 'Rest day'

    const lines = [
      `Today: ${todayLabel}`,
      `Week ${currentWeek} · Phase ${currentPhaseNum}/3`,
      `${progress.weekSessionsDone}/${progress.weekSessionsPlanned} sessions this week`,
      progress.streak > 0 ? `${progress.streak}-day streak 🔥` : 'Start your streak today',
    ]

    res.json({
      service: 'atlas-fit',
      title: 'Training',
      status: 'ok',
      lines,
      actions: [
        { label: 'Training', url: `http://localhost:${PORT}/training` },
        { label: 'Health',   url: `http://localhost:${PORT}/health` },
      ],
    })
  } catch (err) {
    res.status(500).json({ service: 'atlas-fit', title: 'Training', status: 'error', lines: [err.message] })
  }
})

app.get('/api/today', async (_req, res) => {
  try {
    const planData = await readJSON(path.join(HEALTH_DIR, 'training-plan.json'))
    const plan     = planData || {}
    const phases   = plan.phases || []
    const currentPhaseNum = plan.current_phase || 1
    const currentWeek     = plan.current_week  || 1
    const currentPhase    = phases.find(p => p.phase === currentPhaseNum) || null
    const sessions        = currentPhase?.sessions_per_week || []
    const dow             = new Date().getDay()
    const sessionIndexByPhaseDay = {
      1: { 1: 0, 3: 1, 5: 2 },
      2: { 1: 0, 2: 1, 4: 2, 5: 3 },
      3: { 1: 0, 2: 1, 3: 4, 4: 2, 5: 3, 0: 4 },
    }
    const idx          = (sessionIndexByPhaseDay[currentPhaseNum] || {})[dow]
    const todaySession = idx !== undefined ? (sessions[idx] || null) : null

    res.json({
      phase: currentPhaseNum,
      week: currentWeek,
      isRestDay: !todaySession,
      session: todaySession ? {
        label: todaySession.day_label,
        focus: todaySession.focus,
        exerciseCount: (todaySession.exercises || []).length,
        hasCardio: !!todaySession.cardio,
      } : null,
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/training-events', async (_req, res) => {
  try {
    const planData = await readJSON(path.join(HEALTH_DIR, 'training-plan.json'))
    const events   = generateTrainingEvents(planData || {})
    res.json(events)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Error handlers ────────────────────────────────────────────────────────────

app.use((_req, res) => {
  res.status(404).render('404', { title: 'Not Found', atlasUrl: ATLAS_URL })
})

app.use((err, _req, res, _next) => {
  console.error(err)
  res.status(500).render('500', { title: 'Error', atlasUrl: ATLAS_URL })
})

app.listen(PORT, () => {
  console.log(`atlas-fit running on port ${PORT}`)
  console.log(`HEALTH_DIR: ${HEALTH_DIR}`)
  console.log(`ATLAS_URL:  ${ATLAS_URL}`)
})
