import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'
import PropTypes from 'prop-types'
import useScopeValue from '../hooks/use-scope-value'
import useScopeValueSetterOnly from '../hooks/use-scope-value-setter-only'
import usePersistedState from '../hooks/use-persisted-state'
import useAbortController from '../hooks/use-abort-controller'
import DocumentCompiler from '../../features/pdf-preview/util/compiler'
import {
  send,
  sendMB,
  sendMBSampled,
} from '../../infrastructure/event-tracking'
import {
  buildLogEntryAnnotations,
  handleOutputFiles,
} from '../../features/pdf-preview/util/output-files'
import { useIdeContext } from './ide-context'
import { useProjectContext } from './project-context'
import { useEditorContext } from './editor-context'

export const CompileContext = createContext()

CompileContext.Provider.propTypes = {
  value: PropTypes.shape({
    autoCompile: PropTypes.bool.isRequired,
    clearingCache: PropTypes.bool.isRequired,
    clsiServerId: PropTypes.string,
    codeCheckFailed: PropTypes.bool.isRequired,
    compiling: PropTypes.bool.isRequired,
    draft: PropTypes.bool.isRequired,
    error: PropTypes.string,
    fileList: PropTypes.object,
    hasChanges: PropTypes.bool.isRequired,
    highlights: PropTypes.arrayOf(PropTypes.object),
    logEntries: PropTypes.object,
    pdfDownloadUrl: PropTypes.string,
    pdfUrl: PropTypes.string,
    pdfViewer: PropTypes.string,
    position: PropTypes.object,
    rawLog: PropTypes.string,
    setAutoCompile: PropTypes.func.isRequired,
    setDraft: PropTypes.func.isRequired,
    setError: PropTypes.func.isRequired,
    setHasLintingError: PropTypes.func.isRequired, // only for storybook
    setHighlights: PropTypes.func.isRequired,
    setPosition: PropTypes.func.isRequired,
    setShowLogs: PropTypes.func.isRequired,
    setStopOnValidationError: PropTypes.func.isRequired,
    showLogs: PropTypes.bool.isRequired,
    stopOnValidationError: PropTypes.bool.isRequired,
    uncompiled: PropTypes.bool,
    validationIssues: PropTypes.object,
    firstRenderDone: PropTypes.func,
  }),
}

export function CompileProvider({ children }) {
  const ide = useIdeContext()

  const { hasPremiumCompile, isProjectOwner } = useEditorContext()

  const project = useProjectContext()

  const projectId = project._id

  // whether a compile is in progress
  const [compiling, setCompiling] = useState(false)

  // the log entries parsed from the compile output log
  const [logEntries, setLogEntries] = useScopeValueSetterOnly('pdf.logEntries')

  // annotations for display in the editor, built from the log entries
  const [, setLogEntryAnnotations] = useScopeValue('pdf.logEntryAnnotations')

  // the PDF viewer
  const [pdfViewer] = useScopeValue('settings.pdfViewer')

  // the URL for downloading the PDF
  const [pdfDownloadUrl, setPdfDownloadUrl] = useScopeValueSetterOnly(
    'pdf.downloadUrl'
  )

  // the URL for loading the PDF in the preview pane
  const [pdfUrl, setPdfUrl] = useScopeValueSetterOnly('pdf.url')

  // the project is considered to be "uncompiled" if a doc has changed since the last compile started
  const [uncompiled, setUncompiled] = useScopeValue('pdf.uncompiled')

  // the id of the CLSI server which ran the compile
  const [clsiServerId, setClsiServerId] = useState()

  // data received in response to a compile request
  const [data, setData] = useState()

  // callback to be invoked for PdfJsMetrics
  const [firstRenderDone, setFirstRenderDone] = useState()

  // whether the project has been compiled yet
  const [compiledOnce, setCompiledOnce] = useState(false)

  // whether the cache is being cleared
  const [clearingCache, setClearingCache] = useState(false)

  // whether the logs should be visible
  const [showLogs, setShowLogs] = useState(false)

  // an error that occurred
  const [error, setError] = useState()

  // the list of files that can be downloaded
  const [fileList, setFileList] = useState()

  // the raw contents of the log file
  const [rawLog, setRawLog] = useState()

  // validation issues from CLSI
  const [validationIssues, setValidationIssues] = useState()

  // areas to highlight on the PDF, from synctex
  const [highlights, setHighlights] = useState()

  // scroll position of the PDF
  const [position, setPosition] = usePersistedState(`pdf.position.${projectId}`)

  // whether autocompile is switched on
  const [autoCompile, _setAutoCompile] = usePersistedState(
    `autocompile_enabled:${projectId}`,
    false,
    true
  )

  // whether the compile should run in draft mode
  const [draft, setDraft] = usePersistedState(`draft:${projectId}`, false, true)

  // whether compiling should be prevented if there are linting errors
  const [stopOnValidationError, setStopOnValidationError] = usePersistedState(
    `stop_on_validation_error:${projectId}`,
    true,
    true
  )

  // the Document currently open in the editor
  const [currentDoc] = useScopeValue('editor.sharejs_doc')

  // whether the editor linter found errors
  const [hasLintingError, setHasLintingError] = useScopeValue('hasLintingError')

  // whether syntax validation is enabled globally
  const [syntaxValidation] = useScopeValue('settings.syntaxValidation')

  // the timestamp that a doc was last changed or saved
  const [changedAt, setChangedAt] = useState(0)

  const { signal } = useAbortController()

  const cleanupCompileResult = useCallback(() => {
    setPdfUrl(null)
    setPdfDownloadUrl(null)
    setLogEntries(null)
    setLogEntryAnnotations({})
  }, [setPdfUrl, setPdfDownloadUrl, setLogEntries, setLogEntryAnnotations])

  // the document compiler
  const [compiler] = useState(() => {
    return new DocumentCompiler({
      project,
      setChangedAt,
      setCompiling,
      setData,
      setFirstRenderDone,
      setError,
      cleanupCompileResult,
      signal,
    })
  })

  // keep currentDoc in sync with the compiler
  useEffect(() => {
    compiler.currentDoc = currentDoc
  }, [compiler, currentDoc])

  // keep draft setting in sync with the compiler
  useEffect(() => {
    compiler.draft = draft
  }, [compiler, draft])

  // pass the "uncompiled" value up into the scope for use outside this context provider
  useEffect(() => {
    if (window.showNewPdfPreview) {
      setUncompiled(changedAt > 0)
    }
  }, [setUncompiled, changedAt])

  // record changes to the autocompile setting
  const setAutoCompile = useCallback(
    value => {
      _setAutoCompile(value)
      sendMB('autocompile-setting-changed', { value })
    },
    [_setAutoCompile]
  )

  // always compile the PDF once after opening the project, after the doc has loaded
  useEffect(() => {
    if (!compiledOnce && currentDoc) {
      setCompiledOnce(true)
      compiler.compile({ isAutoCompileOnLoad: true })
    }
  }, [compiledOnce, currentDoc, compiler])

  // handle the data returned from a compile request
  // note: this should _only_ run when `data` changes,
  // the other dependencies must all be static
  useEffect(() => {
    if (data) {
      if (data.clsiServerId) {
        setClsiServerId(data.clsiServerId) // set in scope, for PdfSynctexController
      }

      if (data.outputFiles) {
        handleOutputFiles(projectId, data).then(result => {
          setLogEntryAnnotations(
            buildLogEntryAnnotations(result.logEntries.all, ide.fileTreeManager)
          )
          setLogEntries(result.logEntries)
          setFileList(result.fileList)
          setPdfDownloadUrl(result.pdfDownloadUrl)
          setPdfUrl(result.pdfUrl)
          setRawLog(result.log)

          // sample compile stats for real users
          if (!window.user.alphaProgram && data.status === 'success') {
            sendMBSampled(
              'compile-result',
              {
                errors: result.logEntries.errors.length,
                warnings: result.logEntries.warnings.length,
                typesetting: result.logEntries.typesetting.length,
                newPdfPreview: true, // TODO: is this useful?
              },
              0.01
            )
          }
        })
      }

      switch (data.status) {
        case 'success':
          setError(undefined)
          setShowLogs(false)
          break

        case 'clsi-maintenance':
        case 'compile-in-progress':
        case 'exited':
        case 'failure':
        case 'project-too-large':
        case 'rate-limited':
        case 'terminated':
        case 'too-recently-compiled':
          setError(data.status)
          break

        case 'timedout':
          setError('timedout')

          if (!hasPremiumCompile && isProjectOwner) {
            send(
              'subscription-funnel',
              'editor-click-feature',
              'compile-timeout'
            )
            sendMB('paywall-prompt', {
              'paywall-type': 'compile-timeout',
            })
          }
          break

        case 'autocompile-backoff':
          if (!data.options.isAutoCompileOnLoad) {
            setError('autocompile-disabled')
            setAutoCompile(false)
            sendMB('autocompile-rate-limited', { hasPremiumCompile })
          }
          break

        case 'unavailable':
          setError('clsi-unavailable')
          break

        case 'validation-problems':
          setError('validation-problems')
          setValidationIssues(data.validationProblems)
          break

        default:
          setError('error')
          break
      }
    }
  }, [
    data,
    ide,
    hasPremiumCompile,
    isProjectOwner,
    projectId,
    setAutoCompile,
    setClsiServerId,
    setLogEntries,
    setLogEntryAnnotations,
    setPdfDownloadUrl,
    setPdfUrl,
  ])

  // switch to logs if there's an error
  useEffect(() => {
    if (error) {
      setShowLogs(true)
    }
  }, [error])

  // recompile on key press
  useEffect(() => {
    const listener = event => {
      compiler.compile(event.detail)
    }

    window.addEventListener('pdf:recompile', listener)

    return () => {
      window.removeEventListener('pdf:recompile', listener)
    }
  }, [compiler])

  // whether there has been an autocompile linting error, if syntax validation is switched on
  const autoCompileLintingError = Boolean(
    autoCompile && syntaxValidation && hasLintingError
  )

  const codeCheckFailed = stopOnValidationError && autoCompileLintingError

  // the project is available for auto-compiling
  const canAutoCompile = Boolean(autoCompile && !codeCheckFailed)

  // show that the project has pending changes
  const hasChanges = Boolean(canAutoCompile && uncompiled && compiledOnce)

  // call the debounced autocompile function if the project is available for auto-compiling and it has changed
  useEffect(() => {
    if (canAutoCompile) {
      if (changedAt > 0) {
        compiler.debouncedAutoCompile()
      }
    } else {
      compiler.debouncedAutoCompile.cancel()
    }
  }, [compiler, canAutoCompile, changedAt])

  // cancel debounced recompile on unmount
  useEffect(() => {
    return () => {
      compiler.debouncedAutoCompile.cancel()
    }
  }, [compiler])

  // record doc changes when notified by the editor
  useEffect(() => {
    const listener = event => {
      setChangedAt(Date.now())
    }

    window.addEventListener('doc:changed', listener)
    window.addEventListener('doc:saved', listener)

    return () => {
      window.removeEventListener('doc:changed', listener)
      window.removeEventListener('doc:saved', listener)
    }
  }, [])

  // start a compile manually
  const startCompile = useCallback(() => {
    compiler.compile()
  }, [compiler])

  // stop a compile manually
  const stopCompile = useCallback(() => {
    compiler.stopCompile()
  }, [compiler])

  // clear the compile cache
  const clearCache = useCallback(() => {
    setClearingCache(true)

    return compiler.clearCache().finally(() => {
      setClearingCache(false)
    })
  }, [compiler, setClearingCache])

  // clear the cache then run a compile, triggered by a menu item
  const recompileFromScratch = useCallback(() => {
    clearCache().then(() => {
      compiler.compile()
    })
  }, [clearCache, compiler])

  const value = useMemo(
    () => ({
      autoCompile,
      clearCache,
      clearingCache,
      clsiServerId,
      codeCheckFailed,
      compiling,
      draft,
      error,
      fileList,
      hasChanges,
      highlights,
      logEntries,
      pdfDownloadUrl,
      pdfUrl,
      pdfViewer,
      position,
      rawLog,
      recompileFromScratch,
      setAutoCompile,
      setCompiling,
      setDraft,
      setError,
      setHasLintingError, // only for stories
      setHighlights,
      setPosition,
      setShowLogs,
      setStopOnValidationError,
      showLogs,
      startCompile,
      stopCompile,
      stopOnValidationError,
      uncompiled,
      validationIssues,
      firstRenderDone,
    }),
    [
      autoCompile,
      clearCache,
      clearingCache,
      clsiServerId,
      codeCheckFailed,
      compiling,
      draft,
      error,
      fileList,
      hasChanges,
      highlights,
      logEntries,
      position,
      pdfDownloadUrl,
      pdfUrl,
      pdfViewer,
      rawLog,
      recompileFromScratch,
      setAutoCompile,
      setDraft,
      setError,
      setHasLintingError, // only for stories
      setHighlights,
      setPosition,
      setStopOnValidationError,
      showLogs,
      startCompile,
      stopCompile,
      stopOnValidationError,
      uncompiled,
      validationIssues,
      firstRenderDone,
    ]
  )

  return (
    <CompileContext.Provider value={value}>{children}</CompileContext.Provider>
  )
}

CompileProvider.propTypes = {
  children: PropTypes.any,
}

export function useCompileContext(propTypes) {
  const data = useContext(CompileContext)
  PropTypes.checkPropTypes(propTypes, data, 'data', 'CompileContext.Provider')
  return data
}
