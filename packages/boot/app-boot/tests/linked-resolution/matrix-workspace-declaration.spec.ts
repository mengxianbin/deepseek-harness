/** Differential regression matrix · workspace-declaration family (native Node vs profile interception across seven lookup methods). */
import { runFamilySuite } from './harness.ts'
import { selectFamilyCases } from './sampling.ts'

runFamilySuite('workspace-declaration', selectFamilyCases('workspace-declaration'))
