/** Differential regression matrix · placement family (native Node vs profile interception across seven lookup methods). */
import { runFamilySuite } from './harness.ts'
import { selectFamilyCases } from './sampling.ts'

runFamilySuite('placement', selectFamilyCases('placement'))
