/** Differential regression matrix · node-legacy family (native Node vs profile interception across seven lookup methods). */
import { runFamilySuite } from './harness.ts'
import { selectFamilyCases } from './sampling.ts'

runFamilySuite('node-legacy', selectFamilyCases('node-legacy'))
