/** Differential regression matrix · node-comparison-explicit family (native Node vs profile interception across seven lookup methods). */
import { runFamilySuite } from './harness.ts'
import { selectFamilyCases } from './sampling.ts'

runFamilySuite('node-comparison-explicit', selectFamilyCases('node-comparison-explicit'))
