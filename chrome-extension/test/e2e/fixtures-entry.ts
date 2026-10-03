/**
 * Browser bundle of the synthetic ATS fixture builders (the same ones the jsdom
 * suite mounts), so the REAL extension can be run against them: a page loads
 * this bundle and calls `__mount.<name>(document)`. Built on demand by
 * test/e2e/cases/synthetic.mjs with esbuild.
 */
import { mountGreenhouseForm, mountLeverForm, mountBambooHrForm, mountBreezyForm } from "../fixtures/easy";
import {
  mountAshbyForm,
  mountWorkableForm,
  mountSmartRecruitersForm,
  mountJobviteForm,
  mountRipplingForm,
  mountBullhornForm,
} from "../fixtures/medium";
import { mountWorkdayMyInfo } from "../fixtures/workday";
import { mountIcimsForm } from "../fixtures/icims";
import { mountTaleoForm } from "../fixtures/taleo";
import { mountAdpForm } from "../fixtures/adp";
import { mountSuccessFactorsForm } from "../fixtures/successfactors";
import { mountWorkdayShadow } from "../browser/fixtures/workdayShadow";

(window as unknown as { __mount: Record<string, (doc: Document) => unknown> }).__mount = {
  greenhouse: mountGreenhouseForm,
  lever: mountLeverForm,
  bamboohr: mountBambooHrForm,
  breezy: mountBreezyForm,
  ashby: mountAshbyForm,
  workable: mountWorkableForm,
  smartrecruiters: mountSmartRecruitersForm,
  jobvite: mountJobviteForm,
  rippling: mountRipplingForm,
  bullhorn: mountBullhornForm,
  workday: mountWorkdayMyInfo,
  icims: mountIcimsForm,
  taleo: mountTaleoForm,
  adp: mountAdpForm,
  successfactors: mountSuccessFactorsForm,
  "workday-shadow": mountWorkdayShadow,
};
