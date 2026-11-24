Pod::Spec.new do |s|
  s.name           = 'WeldPassNative'
  s.version        = '1.0.0'
  s.summary        = 'WeldPass native pieces: the sensitive clipboard'
  s.description    = s.summary
  s.license        = 'AGPL-3.0-only'
  s.author         = 'WeldSuite'
  s.homepage       = 'https://weldsuite.org'
  s.platforms      = {
    :ios => '17.0'
  }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'UIKit', 'UniformTypeIdentifiers', 'AuthenticationServices'

  s.source_files = "**/*.{h,m,swift}"
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
