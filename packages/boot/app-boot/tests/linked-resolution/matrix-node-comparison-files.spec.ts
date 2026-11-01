/** Differential regression matrix · node-comparison-files family (native Node vs profile interception across seven lookup methods). */
import { runFamilySuite } from './harness.ts'
import { selectFamilyCases } from './sampling.ts'

runFamilySuite('node-comparison-files', selectFamilyCases('node-comparison-files'))
