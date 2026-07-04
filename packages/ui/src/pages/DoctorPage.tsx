import { useEffect, useState } from 'react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/sonner'
import { api } from '@/lib/api'

export function DoctorPage() {
  const [problems, setProblems] = useState<string[] | null>(null)
  const load = async () => { try { setProblems((await api.doctor()).problems) } catch (e: any) { toast.error(e.message) } }
  useEffect(() => { load() }, [])

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between"><h1 className="text-xl font-semibold">Doctor</h1><Button variant="secondary" onClick={load}>Re-run</Button></div>
      {problems === null ? null : problems.length === 0
        ? <Card className="p-6 text-green-500 font-medium">No problems found ✓</Card>
        : <div className="space-y-2">{problems.map((p, i) => <Card key={i} className="p-4 text-sm">{p}</Card>)}</div>}
    </div>
  )
}
